/**
 * Account number and reference number generation.
 *
 * All identifiers are generated from a CSPRNG. Account numbers are additionally
 * checked against the shared unique index inside the registration transaction,
 * so a collision is resolved by retrying rather than by ever risking a
 * duplicate.
 */

import { randomInt, randomBytes } from 'node:crypto';
import { uniqueRef } from '../db/firestore.js';

/**
 * 10-digit customer account number, e.g. `4810273956`.
 * The first digit is fixed at 4 to make account numbers easy to recognise and
 * to leave room for other product ranges later.
 */
export function generateAccountNumber() {
  return `4${randomInt(0, 1_000_000_000).toString().padStart(9, '0')}`;
}

/**
 * Find an account number whose unique index is still free. Read-only: call in
 * the read phase of a transaction and claim the winner with `claimUnique`.
 *
 * @param {import('firebase-admin/firestore').Transaction} txn
 * @param {number} attempts safety bound against a corrupt index
 */
export async function generateUniqueAccountNumber(txn, attempts = 25) {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = generateAccountNumber();
    const snap = await txn.get(uniqueRef(`customerAccount:${candidate}`));
    if (!snap.exists) return candidate;
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
