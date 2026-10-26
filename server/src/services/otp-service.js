/**
 * One-time passwords.
 *
 * Sign-in and transfers are both two-step. For sign-in the password is checked
 * first; for a transfer the PIN is checked first. If that credential holds, the
 * server mints a fresh 6-digit code and records a challenge for that attempt.
 * Only that code completes the challenge, so a leaked password or PIN on its own
 * cannot move money or issue a session.
 *
 * Because no email or SMS provider is wired up, the code is never actually
 * transmitted: the administrator panel reads it back out ("fetch the OTP") and
 * relays it out of band. Challenges are tagged with a `purpose` ('login' or
 * 'transfer') so a code minted for one flow can never be replayed in the other.
 * There is no pre-generated pool - every challenge gets its own code - so the
 * database holds one small document per attempt.
 */

import { randomInt } from 'node:crypto';
import { badRequest } from '../core/errors.js';
import { generateToken } from '../core/crypto.js';
import { C, coll, getById, nowIso, setById, snapRows } from '../db/firestore.js';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;

const CHALLENGE_STATUSES = ['pending', 'consumed', 'expired', 'failed'];

/* -------------------------------------------------------------------------- */
/* Challenge lifecycle                                                        */
/* -------------------------------------------------------------------------- */

/** Six digits, zero-padded, e.g. "042913". */
function generateCode() {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

/**
 * Mint a code for a freshly authenticated customer and record the challenge.
 * Returns `{ challengeId, otpCode, expiresAt }`; the code is returned so the
 * admin panel can surface it.
 */
async function createChallenge(customer, purpose) {
  const challengeId = generateToken(18);
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  await setById(C.loginChallenges, challengeId, {
    challenge_id: challengeId,
    customer_id: String(customer.id),
    customer_email: customer.email,
    otp_code: code,
    purpose,
    status: 'pending',
    attempts: 0,
    created_at: nowIso(),
    expires_at: expiresAt,
    closed_at: null,
    consumed_at: null,
  });

  return { challengeId, otpCode: code, expiresAt };
}

/** Mint a code that completes a sign-in. */
export function createLoginChallenge(customer) {
  return createChallenge(customer, 'login');
}

/** Mint a code that authorises a transfer for an already signed-in customer. */
export function createTransferChallenge(customer) {
  return createChallenge(customer, 'transfer');
}

/**
 * Check a code against a pending challenge. On success the challenge is
 * consumed; a wrong code burns an attempt and the challenge fails after
 * `OTP_MAX_ATTEMPTS`.
 */
async function verifyChallenge(challengeId, code, { purpose, customerId } = {}) {
  const challenge = await getById(C.loginChallenges, challengeId);
  if (!challenge || challenge.status !== 'pending') {
    return { ok: false, reason: 'invalid' };
  }

  // A challenge is bound to the flow that minted it and, for transfers, to the
  // customer who requested it. Neither can be swapped for the other.
  if ((challenge.purpose ?? 'login') !== purpose) {
    return { ok: false, reason: 'invalid' };
  }
  if (customerId !== undefined && String(challenge.customer_id) !== String(customerId)) {
    return { ok: false, reason: 'invalid' };
  }

  if (!(challenge.expires_at > nowIso())) {
    await closeChallenge(challenge, 'expired');
    return { ok: false, reason: 'expired' };
  }

  const provided = String(code ?? '').trim();
  if (provided !== challenge.otp_code) {
    const attempts = (challenge.attempts ?? 0) + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await closeChallenge(challenge, 'failed', { attempts });
      return { ok: false, reason: 'too_many_attempts' };
    }
    await setById(
      C.loginChallenges,
      challengeId,
      { attempts, updated_at: nowIso() },
      { merge: true },
    );
    return { ok: false, reason: 'mismatch', attemptsLeft: OTP_MAX_ATTEMPTS - attempts };
  }

  await setById(
    C.loginChallenges,
    challengeId,
    { status: 'consumed', attempts: (challenge.attempts ?? 0) + 1, consumed_at: nowIso() },
    { merge: true },
  );

  return { ok: true, customerId: challenge.customer_id, otpCode: challenge.otp_code };
}

/** Complete a sign-in challenge with its code. */
export function verifyLoginChallenge(challengeId, code) {
  return verifyChallenge(challengeId, code, { purpose: 'login' });
}

/** Authorise a transfer: the challenge must belong to the signed-in customer. */
export function verifyTransferChallenge(challengeId, code, customerId) {
  return verifyChallenge(challengeId, code, { purpose: 'transfer', customerId });
}

/** Abandon a challenge (wrong credentials, navigation away). */
export async function abandonChallenge(challengeId) {
  const challenge = await getById(C.loginChallenges, challengeId);
  if (!challenge || challenge.status !== 'pending') return;
  await closeChallenge(challenge, 'expired');
}

async function closeChallenge(challenge, status, patch = {}) {
  await setById(
    C.loginChallenges,
    challenge.challenge_id,
    { status, closed_at: nowIso(), ...patch },
    { merge: true },
  );
}

/**
 * A pending challenge whose expiry has passed is expired, whatever the stored
 * status says. The background purge only runs periodically, so the panel must
 * apply the clock at read time or a code stays "awaiting" after its 10-minute
 * window has closed.
 */
function effectiveStatus(row, now) {
  if (row.status === 'pending' && row.expires_at && !(row.expires_at > now)) return 'expired';
  return row.status;
}

/** Housekeeping: close pending challenges past their expiry. */
export async function purgeExpiredChallenges() {
  const snapshot = await coll(C.loginChallenges).where('status', '==', 'pending').get();
  const now = nowIso();
  for (const doc of snapshot.docs) {
    const row = doc.data();
    if (row.expires_at && !(row.expires_at > now)) {
      await closeChallenge({ ...row, challenge_id: doc.id }, 'expired');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Administration                                                             */
/* -------------------------------------------------------------------------- */

const CHALLENGE_PURPOSES = ['login', 'transfer'];

/** Paginated one-time-code challenges for the admin panel (newest first). */
export async function listChallenges({
  status = 'all',
  purpose = 'all',
  search,
  limit = 25,
  offset = 0,
} = {}) {
  if (status && status !== 'all' && !CHALLENGE_STATUSES.includes(status)) {
    throw badRequest('Unknown challenge status filter.');
  }
  if (purpose && purpose !== 'all' && !CHALLENGE_PURPOSES.includes(purpose)) {
    throw badRequest('Unknown challenge purpose filter.');
  }

  const now = nowIso();
  let rows = snapRows(await coll(C.loginChallenges).get());
  rows = rows.map((row) => {
    const effective = effectiveStatus(row, now);
    if (effective === row.status) return row;
    // Persist the expiry in the background; the response must not wait on it,
    // and a transient write failure must not break the listing.
    closeChallenge({ ...row, challenge_id: row.challenge_id ?? row.id }, 'expired').catch(() => {});
    return { ...row, status: effective };
  });
  if (status && status !== 'all') rows = rows.filter((row) => row.status === status);
  if (purpose && purpose !== 'all') {
    rows = rows.filter((row) => (row.purpose ?? 'login') === purpose);
  }
  if (search) {
    const needle = String(search).toLowerCase();
    rows = rows.filter((row) =>
      [row.customer_email, row.otp_code, row.customer_id, row.purpose]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }

  rows.sort((a, b) => {
    if (a.created_at === b.created_at) return String(b.challenge_id).localeCompare(String(a.challenge_id));
    return a.created_at < b.created_at ? 1 : -1;
  });

  const total = rows.length;
  return { rows: rows.slice(offset, offset + limit), total };
}

/** Counts for the admin header, via cheap aggregations. */
export async function otpStats() {
  // Close anything past its 10-minute window first, so the pending count is
  // truthful the moment the page loads rather than whenever the background
  // housekeeping timer next runs.
  try {
    await purgeExpiredChallenges();
  } catch {
    // Count anyway: a transient database hiccup must not break the page.
  }
  const pending = await coll(C.loginChallenges).where('status', '==', 'pending').get();
  let pendingSignIn = 0;
  let pendingTransfer = 0;
  pending.forEach((doc) => {
    if ((doc.data().purpose ?? 'login') === 'transfer') pendingTransfer += 1;
    else pendingSignIn += 1;
  });
  const total = await coll(C.loginChallenges).count().get();
  return {
    pendingChallenges: pending.size,
    pendingSignIn,
    pendingTransfer,
    totalChallenges: total.data().count,
  };
}
