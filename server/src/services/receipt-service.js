/**
 * Receipt generation.
 *
 * Lifecycle:
 *   submit  -> minted immediately, status Pending, carrying the promised
 *              arrival window.
 *   review  -> the same document is rewritten in place to Approved, Rejected
 *              or Cancelled. Receipt number and issue time never change.
 *   settled -> frozen. Once funds have moved the snapshot stops changing.
 *
 * The stored `payload_json` is what the printable view renders, so the customer
 * and the admin see byte-identical documents. A few transfer fields are also
 * denormalised onto the receipt so the customer archive can be listed without a
 * join.
 */

import {
  C,
  nowIso,
  getById,
  setById,
  snapRows,
  coll,
  transaction,
  readCounter,
  bumpCounter,
  checkUnique,
  claimUnique,
  txnSet,
} from '../db/firestore.js';
import { generateReceiptNumber } from '../core/identifiers.js';
import { formatCents } from '../core/money.js';
import { getSetting } from './settings.js';

const TYPE_LABELS = {
  local: 'Local Transfer',
  international: 'International Transfer',
  wire: 'Wire Transfer',
};

const STATUS_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const SETTLED_STATUSES = new Set(['approved']);

const ARRIVAL_WINDOW_HOURS = 24;
const ARRIVAL_HINT = `Money will arrive within ${ARRIVAL_WINDOW_HOURS} hours.`;

export { ARRIVAL_HINT, ARRIVAL_WINDOW_HOURS };

function arrivalBy(requestedAt) {
  return new Date(new Date(requestedAt).getTime() + ARRIVAL_WINDOW_HOURS * 3_600_000).toISOString();
}

function buildPayload(transfer, { receiptNumber, issuedAt }) {
  const settled = SETTLED_STATUSES.has(transfer.status);

  return {
    receiptNumber,
    issuedAt,
    bank: {
      name: getSetting('bank_name', 'Northbridge Bank'),
      supportEmail: getSetting('support_email', 'support@northbridge.bank'),
      supportPhone: getSetting('support_phone', '+1 (800) 555-0142'),
    },
    customer: {
      name: transfer.customer_name,
      accountNumber: transfer.customer_account_number,
      email: transfer.customer_email,
    },
    transaction: {
      referenceNumber: transfer.reference_number,
      transferType: transfer.transfer_type,
      transferTypeLabel: TYPE_LABELS[transfer.transfer_type] ?? transfer.transfer_type,
      status: transfer.status,
      statusLabel: STATUS_LABELS[transfer.status] ?? transfer.status,
      requestedAt: transfer.requested_at,
      settledAt: transfer.settled_at,
      expectedArrivalBy: arrivalBy(transfer.requested_at),
      arrivalHint: ARRIVAL_HINT,
      final: settled,
    },
    recipient: {
      name: transfer.recipient_name,
      accountNumber: transfer.recipient_account_number,
      accountName: transfer.recipient_account_name ?? null,
      bank: transfer.recipient_bank_name,
      routingNumber: transfer.recipient_routing_number,
      iban: transfer.recipient_iban,
      swiftBic: transfer.recipient_swift_bic,
      cnaps: transfer.recipient_cnaps ?? null,
      country: transfer.recipient_country,
    },
    amounts: {
      amountCents: transfer.amount_cents,
      feeCents: transfer.fee_cents,
      totalDebitCents: transfer.total_debit_cents,
      amountFormatted: formatCents(transfer.amount_cents),
      feeFormatted: formatCents(transfer.fee_cents),
      totalDebitFormatted: formatCents(transfer.total_debit_cents),
      debited: settled,
    },
    description: transfer.description,
    reviewedAt: transfer.reviewed_at,
    rejectionReason: transfer.rejection_reason ?? null,
  };
}

/** The transfer joined with the customer fields the receipt records. */
async function loadTransferForReceipt(transferId) {
  const transfer = await getById(C.transfers, transferId);
  if (!transfer) return null;
  const customer = await getById(C.customers, transfer.customer_id);
  return {
    ...transfer,
    customer_name: customer?.full_name ?? null,
    customer_account_number: customer?.account_number ?? null,
    customer_email: customer?.email ?? null,
  };
}

function receiptDoc(transfer, { receiptNumber, issuedAt, payload }) {
  return {
    receipt_number: receiptNumber,
    transfer_id: transfer.id,
    customer_id: transfer.customer_id,
    issued_at: issuedAt,
    status: transfer.status,
    transfer_type: transfer.transfer_type,
    amount_cents: transfer.amount_cents,
    fee_cents: transfer.fee_cents,
    total_debit_cents: transfer.total_debit_cents,
    recipient_name: transfer.recipient_name,
    recipient_bank_name: transfer.recipient_bank_name,
    reference_number: transfer.reference_number,
    payload_json: JSON.stringify(payload),
  };
}

/** Find the receipt row for a transfer (transfer_id is unique). */
async function findByTransferId(transferId, customerId = null) {
  let query = coll(C.receipts).where('transfer_id', '==', transferId);
  if (customerId !== null && customerId !== undefined) {
    query = query.where('customer_id', '==', customerId);
  }
  const snap = await query.limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

/**
 * Mint the receipt for a transfer. Idempotent: an existing receipt is returned
 * unchanged.
 *
 * @param {number} transferId
 * @returns {Promise<object|null>} the receipt including `payload`
 */
export async function issueReceipt(transferId) {
  const existing = await findByTransferId(transferId);
  if (existing) return hydrate(existing);

  const transfer = await loadTransferForReceipt(transferId);
  if (!transfer) throw new Error(`Cannot issue a receipt: transfer ${transferId} does not exist`);
  if (transfer.status !== 'pending' && transfer.status !== 'approved') {
    throw new Error(
      `Cannot issue a receipt: transfer ${transferId} is ${transfer.status}, which is not a state that issues one`,
    );
  }

  const receiptNumber = generateReceiptNumber();
  const issuedAt = nowIso();
  const payload = buildPayload(transfer, { receiptNumber, issuedAt });

  await transaction(async (txn) => {
    const id = await readCounter(txn, C.receipts);
    await checkUnique(txn, `receiptTransfer:${transfer.id}`, id);
    bumpCounter(txn, C.receipts, id);
    claimUnique(txn, `receiptTransfer:${transfer.id}`, id);
    claimUnique(txn, `receiptNumber:${receiptNumber}`, id);
    txnSet(txn, C.receipts, id, receiptDoc(transfer, { receiptNumber, issuedAt, payload }));
  });

  return receiptForTransfer(transfer.id);
}

/**
 * Rewrite an existing receipt to match the transfer's current state. Refuses to
 * touch a receipt whose transfer has already settled.
 */
export async function refreshReceipt(transferId) {
  const existing = await findByTransferId(transferId);
  if (!existing) return null;

  const current = hydrate(existing);
  if (current?.payload?.transaction?.final) return current;

  const transfer = await loadTransferForReceipt(transferId);
  if (!transfer) return current;

  const payload = buildPayload(transfer, {
    receiptNumber: current.receiptNumber,
    issuedAt: current.issuedAt,
  });

  await setById(
    C.receipts,
    existing.id,
    {
      status: transfer.status,
      transfer_type: transfer.transfer_type,
      amount_cents: transfer.amount_cents,
      fee_cents: transfer.fee_cents,
      total_debit_cents: transfer.total_debit_cents,
      recipient_name: transfer.recipient_name,
      recipient_bank_name: transfer.recipient_bank_name,
      reference_number: transfer.reference_number,
      payload_json: JSON.stringify(payload),
    },
    { merge: true },
  );

  return receiptForTransfer(transferId);
}

/** Parse the stored JSON snapshot. */
export function hydrate(receiptRow) {
  if (!receiptRow) return null;
  let payload;
  try {
    payload = JSON.parse(receiptRow.payload_json);
  } catch {
    return null;
  }
  return {
    id: receiptRow.id,
    receiptNumber: receiptRow.receipt_number,
    transferId: receiptRow.transfer_id,
    customerId: receiptRow.customer_id,
    issuedAt: receiptRow.issued_at,
    payload,
  };
}

/** Receipt for a transfer, or null when the transfer has not settled. */
export async function receiptForTransfer(transferId) {
  return hydrate(await findByTransferId(transferId));
}

/** Receipt owned by a specific customer. */
export async function receiptForCustomerTransfer(transferId, customerId) {
  return hydrate(await findByTransferId(transferId, customerId));
}

/** Paginated settled receipts for a customer, newest first. */
export async function listCustomerReceipts(customerId, { limit = 20, offset = 0 } = {}) {
  const snap = await coll(C.receipts)
    .where('customer_id', '==', customerId)
    .where('status', '==', 'approved')
    .get();
  const rows = snapRows(snap);
  rows.sort((a, b) => {
    if (a.issued_at === b.issued_at) return b.id - a.id;
    return a.issued_at < b.issued_at ? 1 : -1;
  });
  const total = rows.length;
  return { rows: rows.slice(offset, offset + limit), total };
}
