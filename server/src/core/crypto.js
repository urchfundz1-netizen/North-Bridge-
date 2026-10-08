/**
 * Password and transfer-PIN hashing.
 *
 * Uses scrypt (memory-hard) from Node's crypto module with a per-secret random
 * salt and a versioned, self-describing string format:
 *
 *     scrypt$N$r$p$<salt base64>$<derived key base64>
 *
 * Embedding the parameters means the cost can be raised later without
 * invalidating existing hashes - `needsRehash` detects out-of-date secrets and
 * re-hashes them on the next successful login.
 *
 * Verification is constant-time, and a malformed stored hash is treated as a
 * failed verification rather than an error, so a corrupt row can never be used
 * to bypass authentication.
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

/** Current cost parameters. N=2^15 with r=8 lands around ~100ms per hash. */
const PARAMS = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * scrypt needs roughly 128 * N * r bytes (32 MB at the parameters above), which
 * is just over OpenSSL's 32 MB default cap. Raise it explicitly so hashing
 * fails for a known reason rather than an opaque OpenSSL error.
 */
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

/**
 * Work factor floors. Hashes produced with weaker parameters are still
 * verifiable (so old accounts keep working) but are flagged for upgrade.
 */
const MIN_PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Cannot hash an empty secret');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plaintext.normalize('NFKC'), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifySecret(plaintext, storedHash) {
  if (typeof plaintext !== 'string' || typeof storedHash !== 'string') return false;

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts;
  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  // Refuse absurd parameters so a tampered row cannot become a CPU DoS vector.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  try {
    const salt = Buffer.from(saltRaw, 'base64');
    const expected = Buffer.from(keyRaw, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    // Cap maxmem generously so a hash created under a larger N still verifies,
    // while still refusing the absurd values rejected above.
    const maxmem = Math.max(MAX_MEM, 256 * N * r);
    const derived = await scrypt(plaintext.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash used weaker parameters than the current policy. */
export function needsRehash(storedHash) {
  const parts = String(storedHash ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  return N < MIN_PARAMS.N || r < MIN_PARAMS.r || p < MIN_PARAMS.p;
}

/**
 * SHA-256 of an opaque session token.
 *
 * The database only ever stores this digest, never the token itself, so a
 * database dump cannot be replayed as a valid login session.
 */
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** A cryptographically random, URL-safe opaque token. */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}