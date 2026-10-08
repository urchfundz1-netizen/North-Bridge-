/**
 * Ledger service - the only code permitted to change a balance.
 *
 * Every balance movement is a signed `ledger_entries` row carrying a
 * `balance_after_cents` snapshot. Two invariants are enforced here and in the
 * schema:
 *
 *   1. UNIQUE (transfer_id, entry_type) means a transfer can never be settled
 *      twice.
 *   2. The balance UPDATE itself is conditional (`balance_cents >= ?`), so two
 *      concurrent debits cannot both slip past a stale in-memory balance.
 *
 * Historical entries are never updated or deleted. Corrections are made by
 * posting an offsetting `adjustment` entry, which leaves the audit trail intact.
 */

import { getDb, one, run, nowIso } from '../db/connection.js';
import { conflict, notFound } from '../core/errors.js';

export const ENTRY_TYPES = {
  DEPOSIT: 'deposit',
  TRANSFER_PRINCIPAL: 'transfer_principal',
  TRANSFER_FEE: 'transfer_fee',
  ADJUSTMENT: 'adjustment',
};

/** Current balance in cents for a customer. */
export function getBalance(customerId) {
  const row = one('SELECT balance_cents FROM customers WHERE id = ?', [customerId]);
  if (!row) return null;
  return row.balance_cents;
}

/**
 * Apply a signed amount to a balance and append a ledger row, atomically.
 *
 * The whole function is designed to be called inside an existing transaction
 * (see `transaction()` in db/connection.js) so that the balance change and its
 * ledger row commit together or not at all.
 *
 * @param {object} entry
 * @param {number} entry.customerId
 * @param {number} entry.amountCents  signed: negative debits the account
 * @param {string} entry.entryType    one of ENTRY_TYPES
 * @param {string} entry.description
 * @param {number} [entry.transferId]
 * @param {number} [entry.adminId]
 * @param {string} [entry.referenceNumber]
 * @returns {{ balanceAfterCents: number, entryId: number }}
 * @throws {ApiError} 409 `insufficient_funds` when a debit would overdraw the
 *   account, 404 when the customer no longer exists.
 */
export function postEntry(entry) {
  const {
    customerId,
    amountCents,
    entryType,
    description,
    transferId = null,
    adminId = null,
    referenceNumber = null,
  } = entry;

  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    throw new Error('Ledger amount must be a non-zero integer number of cents');
  }

  const db = getDb();

  const customer = one('SELECT id, balance_cents FROM customers WHERE id = ?', [customerId]);
  if (!customer) {
    throw notFound('Account not found.');
  }

  // Conditional update: for a debit, only succeed if the funds are genuinely
  // there right now. This is the second line of defence against overdrafts.
  const updated =
    amountCents < 0
      ? db
          .prepare(
            `UPDATE customers
                SET balance_cents = balance_cents + ?, updated_at = ?
              WHERE id = ? AND balance_cents + ? >= 0`,
          )
          .run(amountCents, nowIso(), customerId, amountCents)
      : db
          .prepare('UPDATE customers SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?')
          .run(amountCents, nowIso(), customerId);

  if (updated.changes !== 1) {
    throw conflict('Insufficient available balance for this transaction.', {
      availableBalanceCents: customer.balance_cents,
      requestedCents: Math.abs(amountCents),
    });
  }

  const balanceAfterCents = customer.balance_cents + amountCents;

  // The (transfer_id, entry_type) UNIQUE constraint rejects a second settlement
  // of the same transfer. Because we are inside BEGIN IMMEDIATE, a competing
  // approval request is already blocked on the write lock by this point.
  const inserted = run(
    `INSERT INTO ledger_entries
       (customer_id, amount_cents, balance_after_cents, entry_type, transfer_id,
        admin_id, description, reference_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      customerId,
      amountCents,
      balanceAfterCents,
      entryType,
      transferId,
      adminId,
      description,
      referenceNumber,
    ],
  );

  return { entryId: Number(inserted.lastInsertRowid), balanceAfterCents };
}

/**
 * Paginated statement for a customer, newest first.
 * @param {number} customerId
 * @param {{ limit?: number, offset?: number, entryType?: string }} options
 */
export function listEntries(customerId, { limit = 50, offset = 0, entryType = null } = {}) {
  const params = [customerId];
  let where = 'WHERE customer_id = ?';
  if (entryType) {
    where += ' AND entry_type = ?';
    params.push(entryType);
  }
  params.push(limit, offset);

  const rows = getDb()
    .prepare(
      `SELECT * FROM ledger_entries ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params);

  const { total } = one(
    `SELECT COUNT(*) AS total FROM ledger_entries
      ${entryType ? 'WHERE customer_id = ? AND entry_type = ?' : 'WHERE customer_id = ?'}`,
    entryType ? [customerId, entryType] : [customerId],
  );

  return { rows, total };
}

/** Totals for a customer's statement header. */
export function summarise(customerId) {
  const row = one(
    `SELECT
        COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS credited_cents,
        COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END), 0) AS debited_cents,
        COUNT(*) AS entry_count
      FROM ledger_entries
     WHERE customer_id = ?`,
    [customerId],
  );
  return {
    creditedCents: row?.credited_cents ?? 0,
    debitedCents: row?.debited_cents ?? 0,
    entryCount: row?.entry_count ?? 0,
  };
}