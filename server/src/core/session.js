/**
 * Session management.
 *
 * Design notes
 *   * Sessions live in the database. The browser only ever holds an opaque
 *     random token in an `httpOnly` cookie, so JavaScript (including any XSS)
 *     cannot read it, and the database stores only the token's SHA-256 digest.
 *   * Customer and admin sessions use separate cookies AND are constrained to
 *     their own `actor_type`. An admin cookie therefore cannot satisfy a
 *     customer route, and vice versa - this is enforced in SQL, not just in
 *     middleware.
 *   * Each session row carries its own CSRF token for double-submit protection.
 */

import { getDb, one, run, nowIso } from '../db/connection.js';
import { generateToken, hashToken } from './crypto.js';
import { config, COOKIE_NAMES } from './config.js';

const MS_PER_HOUR = 3_600_000;

/**
 * Create a session and return `{ token, csrfToken, expiresAt }`.
 * @param {'customer'|'admin'} actorType
 */
export function createSession(actorType, actorId, request = null) {
  const token = generateToken(32);
  const csrfToken = generateToken(24);
  const ttlHours = actorType === 'admin' ? config.adminSessionTtlHours : config.sessionTtlHours;
  const expiresAt = new Date(Date.now() + ttlHours * MS_PER_HOUR).toISOString();

  run(
    `INSERT INTO sessions
       (token_hash, actor_type, actor_id, csrf_token, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      hashToken(token),
      actorType,
      actorId,
      csrfToken,
      request ? (request.ip ?? null) : null,
      request ? (request.get('user-agent') ?? null).slice(0, 300) : null,
      expiresAt,
    ],
  );

  return { token, csrfToken, expiresAt };
}

/**
 * Resolve a session token to its row, enforcing actor type and expiry.
 * Returns null for unknown, expired, revoked, or wrong-actor tokens.
 */
export function resolveSession(token, expectedActorType) {
  if (!token || typeof token !== 'string') return null;

  const row = one(
    `SELECT * FROM sessions
      WHERE token_hash = ?
        AND actor_type = ?
        AND revoked_at IS NULL
        AND expires_at > ?`,
    [hashToken(token), expectedActorType, nowIso()],
  );
  if (!row) return null;

  // Best-effort activity tracking; ignore write failures so a read never 500s.
  try {
    run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), row.id]);
  } catch {
    /* non-critical */
  }
  return row;
}

export function revokeSession(token, actorType) {
  if (!token) return;
  run(
    'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND actor_type = ? AND revoked_at IS NULL',
    [nowIso(), hashToken(token), actorType],
  );
}

/** Revoke every session for an actor. Used on logout-everywhere and on
 *  administrative account disable / customer status changes. */
export function revokeSessionsFor(actorType, actorId) {
  run(
    'UPDATE sessions SET revoked_at = ? WHERE actor_type = ? AND actor_id = ? AND revoked_at IS NULL',
    [nowIso(), actorType, actorId],
  );
}

/** Housekeeping: delete sessions that expired or were revoked over a day ago. */
export function purgeExpiredSessions() {
  const cutoff = new Date(Date.now() - 24 * MS_PER_HOUR).toISOString();
  run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [
    cutoff,
    cutoff,
  ]);
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
/* Attempt throttling                                                        */
/* -------------------------------------------------------------------------- */

/**
 * In-memory sliding-window limiter keyed by IP and by account identifier.
 *
 * This is intentionally per-process. Behind more than one instance, swap in a
 * shared store (Redis) - the call sites would not need to change.
 */
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

export { getDb };