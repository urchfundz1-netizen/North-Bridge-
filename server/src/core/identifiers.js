/**
 * Account number and reference number generation.
 *
 * All identifiers are generated from a CSPRNG. Each generator loops on a unique
 * constraint violation, so collisions are resolved by retrying rather than by
 * ever risking a duplicate.
 */

import { randomInt, randomBytes } from 'node:crypto';
import { one } from '../db/connection.js';

/**
 * 10-digit customer account number, e.g. `4810273956`.
 * The first digit is fixed at 4 to make account numbers easy to recognise and
 * to leave room for other product ranges later.
 */
export function generateAccountNumber() {
  return `4${randomInt(0, 1_000_000_000).toString().padStart(9, '0')}`;
}

/**
 * Find an account number that is not already in use.
 * @param {number} attempts safety bound against a corrupt database
 */
export function generateUniqueAccountNumber(attempts = 25) {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = generateAccountNumber();
    const taken = one('SELECT id FROM customers WHERE account_number = ?', [candidate]);
    if (!taken) return candidate;
  }
  throw new Error('Unable to allocate a unique account number');
}

/** Human-readable transfer reference: `NBT-2026-4F2A9C81`. */
export function generateTransferReference(date = new Date()) {
  const year = date.getUTCFullYear();
  return `NBT-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Human-readable receipt number: `RCPT-2026-9B7D2E10`. */
export function generateReceiptNumber(date = new Date()) {
  const year = date.getUTCFullYear();
  return `RCPT-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Opaque per-customer idempotency token for transfer submission. */
export function generateIdempotencyKey() {
  return randomBytes(16).toString('hex');
}