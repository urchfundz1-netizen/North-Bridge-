/**
 * Session management (Firestore).
 *
 * Design notes
 *   * Sessions live in Firestore, keyed by the SHA-256 digest of the opaque
 *     cookie token. The browser only ever holds the random token in an
 *     `httpOnly` cookie, so a leaked database cannot be replayed as a login.
 *   * Customer and admin sessions use separate cookies AND are constrained to
 *     their own `actor_type`. An admin cookie therefore cannot satisfy a
 *     customer route, and vice versa.
 *   * Each session carries its own CSRF token for double-submit protection.
 *
 * Serverless note: the in-memory rate-limit buckets below are per-instance.
 * Behind more than one instance they under-count; a shared store (Redis or a
 * Firestore counter doc) is the upgrade path. Kept in-memory for now so the
 * call sites do not change.
 */

import { db, C, nowIso } from '../db/firestore.js';
import { generateToken, hashToken } from './crypto.js';
import { config, COOKIE_NAMES } from './config.js';

const MS_PER_HOUR = 3_600_000;

/**
 * Create a session and return `{ token, csrfToken, expiresAt }`.
 * @param {'customer'|'admin'} actorType
 */
export async function createSession(actorType, actorId, request = null) {
  const token = generateToken(32);
  const csrfToken = generateToken(24);
  const ttlHours = actorType === 'admin' ? config.adminSessionTtlHours : config.sessionTtlHours;
  const expiresAt = new Date(Date.now() + ttlHours * MS_PER_HOUR).toISOString();
  const tokenHash = hashToken(token);
  const now = nowIso();

  await db().collection(C.sessions).doc(tokenHash).set({
    token_hash: tokenHash,
    actor_type: actorType,
    actor_id: String(actorId),
    csrf_token: csrfToken,
    ip_address: request ? (request.ip ?? null) : null,
    user_agent: request ? (request.get('user-agent') ?? null).slice(0, 300) : null,
    created_at: now,
    last_seen_at: now,
    expires_at: expiresAt,
    revoked_at: null,
  });

  return { token, csrfToken, expiresAt };
}

/**
 * Resolve a session token to its row, enforcing actor type and expiry.
 * Returns null for unknown, expired, revoked, or wrong-actor tokens.
 */
export async function resolveSession(token, expectedActorType) {
  if (!token || typeof token !== 'string') return null;

  const tokenHash = hashToken(token);
  const ref = db().collection(C.sessions).doc(tokenHash);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const row = { id: tokenHash, ...snap.data() };
  if (row.actor_type !== expectedActorType) return null;
  if (row.revoked_at) return null;
  if (!(row.expires_at > nowIso())) return null;

  // Best-effort activity tracking; never fail a request over it.
  ref.set({ last_seen_at: nowIso() }, { merge: true }).catch(() => {});
  return row;
}

export async function revokeSession(token, actorType) {
  if (!token) return;
  const row = await resolveSession(token, actorType);
  if (!row) return;
  await db().collection(C.sessions).doc(row.id).set({ revoked_at: nowIso() }, { merge: true });
}

/** Revoke every session for an actor. Used on logout-everywhere and on
 *  administrative account disable / customer status changes. */
export async function revokeSessionsFor(actorType, actorId) {
  const snap = await db()
    .collection(C.sessions)
    .where('actor_type', '==', actorType)
    .where('actor_id', '==', String(actorId))
    .where('revoked_at', '==', null)
    .get();

  if (snap.empty) return;
  const batch = db().batch();
  snap.forEach((doc) => batch.set(doc.ref, { revoked_at: nowIso() }, { merge: true }));
  await batch.commit();
}

/** Housekeeping: delete sessions that expired or were revoked over a day ago. */
export async function purgeExpiredSessions() {
  const cutoff = new Date(Date.now() - 24 * MS_PER_HOUR).toISOString();
  const snap = await db().collection(C.sessions).where('expires_at', '<', cutoff).get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

/* -------------------------------------------------------------------------- */
/* Cookie helpers                                                             */
/* -------------------------------------------------------------------------- */

export function cookieNameFor(actorType) {
  return actorType === 'admin' ? COOKIE_NAMES.admin : COOKIE_NAMES.customer;
}

export function setSessionCookie(res, actorType, token, expiresAt) {
  res.cookie(cookieNameFor(actorType), token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(res, actorType) {
  res.clearCookie(cookieNameFor(actorType), {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
  });
}

/* -------------------------------------------------------------------------- */
/* Attempt throttling                                                         */
/* -------------------------------------------------------------------------- */

const buckets = new Map();

const WINDOW_MS = 15 * 60 * 1000;

export function checkRateLimit(key, { limit, windowMs = WINDOW_MS, blockMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { failures: 0, blockedUntil: 0, firstFailureAt: now };
    buckets.set(key, bucket);
  }

  if (bucket.blockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000) };
  }
  if (bucket.firstFailureAt + windowMs < now) {
    bucket.failures = 0;
    bucket.firstFailureAt = now;
  }
  if (bucket.failures >= limit) {
    bucket.blockedUntil = now + blockMs;
    return { allowed: false, retryAfterSeconds: Math.ceil(blockMs / 1000) };
  }
  return { allowed: true };
}

export function recordFailure(key, limit, windowMs = WINDOW_MS, blockMs = 15 * 60 * 1000) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { failures: 0, blockedUntil: 0, firstFailureAt: now };
    buckets.set(key, bucket);
  }
  if (bucket.firstFailureAt + windowMs < now) {
    bucket.failures = 0;
    bucket.firstFailureAt = now;
  }
  bucket.failures += 1;
  if (bucket.failures >= limit) {
    bucket.blockedUntil = now + blockMs;
  }
}

export function clearFailures(key) {
  buckets.delete(key);
}

/** Drop expired buckets so the Map cannot grow without bound. */
export function pruneRateLimits() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.blockedUntil < now && bucket.firstFailureAt + WINDOW_MS < now) {
      buckets.delete(key);
    }
  }
}
