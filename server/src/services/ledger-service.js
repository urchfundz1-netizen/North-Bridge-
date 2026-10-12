/**
 * Ledger service - the only code permitted to change a balance.
 *
 * Every balance movement is a signed `ledger_entries` document carrying a
 * `balance_after_cents` snapshot. Two invariants are enforced here:
 *
 *   1. A per-transfer unique index (`ledger:<transferId>:<entryType>`) means a
 *      transfer can never be settled twice - the second attempt fails on the
 *      unique claim regardless of application race conditions.
 *   2. The new balance is computed inside the transaction and rejected when it
 *      would go negative, so concurrent debits cannot both slip past a stale
 *      in-memory balance.
 *
 * Historical entries are never updated or deleted. Corrections are made by
 * posting an offsetting `adjustment` entry, which leaves the trail intact.
 *
 * `postEntries` is called inside a caller's transaction and follows the
 * Firestore rule that all reads precede all writes: it reads the counter, the
 * affected customers and the settlement guards first, then writes.
 */

import {
  C,
  nowIso,
  getById,
  txnGetById,
  readCounter,
  bumpCounter,
  claimUnique,
  txnSet,
  uniqueRef,
  snapRows,
  coll,
} from '../db/firestore.js';
import { conflict, notFound } from '../core/errors.js';

export const ENTRY_TYPES = {
  DEPOSIT: 'deposit',
  TRANSFER_PRINCIPAL: 'transfer_principal',
  TRANSFER_FEE: 'transfer_fee',
  ADJUSTMENT: 'adjustment',
};

/** Current balance in cents for a customer. */
export async function getBalance(customerId) {
  const row = await getById(C.customers, customerId);
  if (!row) return null;
  return row.balance_cents;
}

/**
 * Apply one or more signed amounts to balances and append a ledger document for
 * each, atomically. Must be called inside a transaction; the caller owns that
 * transaction and pre-reserves nothing.
 *
 * @param {Array<object>} entries each: { customerId, amountCents, entryType,
 *   description, transferId?, adminId?, referenceNumber? }
 * @param {import('firebase-admin/firestore').Transaction} txn
 * @returns {Promise<Array<{ entryId: number, balanceAfterCents: number }>>}
 */
export async function postEntries(entries, txn) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('postEntries requires at least one entry');
  }
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents === 0) {
      throw new Error('Ledger amount must be a non-zero integer number of cents');
    }
  }

  // --- Read phase -----------------------------------------------------------
  const baseId = await readCounter(txn, C.ledger);

  const customerIds = [...new Set(entries.map((e) => e.customerId))];
  const customers = new Map();
  for (const id of customerIds) {
    const customer = await txnGetById(txn, C.customers, id);
    if (!customer) throw notFound('Account not found.');
    customers.set(id, customer);
  }

  const guards = new Map();
  for (const entry of entries) {
    if (!entry.transferId) continue;
    const key = `ledger:${entry.transferId}:${entry.entryType}`;
    const snap = await txn.get(uniqueRef(key));
    guards.set(key, snap.exists);
  }

  // --- Compute --------------------------------------------------------------
  const deltas = new Map();
  const balancesAfter = new Map();
  entries.forEach((entry, index) => {
    const customer = customers.get(entry.customerId);
    deltas.set(entry.customerId, (deltas.get(entry.customerId) ?? 0) + entry.amountCents);
    balancesAfter.set(index, (customer.balance_cents ?? 0) + entry.amountCents);
  });

  for (const [customerId, delta] of deltas) {
    const customer = customers.get(customerId);
    if ((customer.balance_cents ?? 0) + delta < 0) {
      const requested = entries
        .filter((e) => e.customerId === customerId && e.amountCents < 0)
        .reduce((sum, e) => sum + Math.abs(e.amountCents), 0);
      throw conflict('Insufficient available balance for this transaction.', {
        availableBalanceCents: customer.balance_cents,
        requestedCents: requested,
      });
    }
  }

  // --- Write phase ----------------------------------------------------------
  bumpCounter(txn, C.ledger, baseId + entries.length - 1);

  for (const [customerId, delta] of deltas) {
    const customer = customers.get(customerId);
    txnSet(txn, C.customers, customerId, {
      balance_cents: (customer.balance_cents ?? 0) + delta,
      updated_at: nowIso(),
    }, { merge: true });
  }

  const results = [];
  entries.forEach((entry, index) => {
    const entryId = baseId + index;
    if (entry.transferId) {
      const key = `ledger:${entry.transferId}:${entry.entryType}`;
      if (guards.get(key)) {
        throw conflict('This transfer has already been settled.');
      }
      claimUnique(txn, key, entryId);
    }
    txnSet(txn, C.ledger, entryId, {
      customer_id: entry.customerId,
      amount_cents: entry.amountCents,
      balance_after_cents: balancesAfter.get(index),
      entry_type: entry.entryType,
      transfer_id: entry.transferId ?? null,
      admin_id: entry.adminId ?? null,
      description: entry.description,
      reference_number: entry.referenceNumber ?? null,
      created_at: nowIso(),
    });
    results.push({ entryId, balanceAfterCents: balancesAfter.get(index) });
  });

  return results;
}

/** Convenience wrapper for a single ledger entry. */
export async function postEntry(entry, txn) {
  const [result] = await postEntries([entry], txn);
  return result;
}

/**
 * Paginated statement for a customer, newest first. Fetches the customer's
 * entries and filters/slices in memory; a bank statement is bounded and this
 * avoids maintaining composite indexes.
 */
export async function listEntries(customerId, { limit = 50, offset = 0, entryType = null } = {}) {
  const snap = await coll(C.ledger).where('customer_id', '==', customerId).get();
  let rows = snapRows(snap);
  if (entryType) rows = rows.filter((row) => row.entry_type === entryType);
  rows.sort((a, b) => b.id - a.id);
  const total = rows.length;
  rows = rows.slice(offset, offset + limit);

  const adminIds = [...new Set(rows.map((r) => r.admin_id).filter(Boolean))];
  if (adminIds.length) {
    const admins = new Map();
    for (const id of adminIds) {
      const admin = await getById(C.admins, id);
      if (admin) admins.set(id, admin);
    }
    rows = rows.map((row) =>
      row.admin_id && admins.has(row.admin_id)
        ? { ...row, admin_name: admins.get(row.admin_id).full_name, admin_email: admins.get(row.admin_id).email }
        : row,
    );
  }

  return { rows, total };
}

/** Totals for a customer's statement header. */
export async function summarise(customerId) {
  const snap = await coll(C.ledger).where('customer_id', '==', customerId).get();
  let creditedCents = 0;
  let debitedCents = 0;
  snap.forEach((doc) => {
    const amount = doc.data().amount_cents ?? 0;
    if (amount > 0) creditedCents += amount;
    else debitedCents += -amount;
  });
  return { creditedCents, debitedCents, entryCount: snap.size };
}
