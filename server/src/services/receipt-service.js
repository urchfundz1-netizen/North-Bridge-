/**
 * Receipt generation.
 *
 * Lifecycle, and the reason it is written this way:
 *
 *   submit   -> minted immediately, status Pending, carrying the promised
 *               arrival window. The customer has just confirmed their transfer
 *               PIN, so they leave with a numbered document in hand rather than
 *               an empty slot and a promise to check back later.
 *   review   -> the same document is rewritten in place to Approved, Rejected
 *               or Cancelled. Receipt number and issue time never change, so
 *               the document a customer printed at submit time and the one they
 *               are looking at now are recognisably the same receipt.
 *   settled  -> frozen. Once funds have actually moved the snapshot stops
 *               changing: if an administrator later renames the bank or edits a
 *               customer's address, a settled receipt must still read exactly as
 *               it did on the day the money moved.
 *
 * So a pending receipt is deliberately mutable and a settled one is not. That
 * split is the whole design: the snapshot guarantee is worth keeping exactly
 * where it was previously claimed - on money that has left the account.
 *
 * The stored payload is also what the printable receipt view renders, so the
 * customer and the admin see byte-identical documents.
 */

import { one, many, run, nowIso } from '../db/connection.js';
import { generateReceiptNumber } from '../core/identifiers.js';
import { formatCents } from '../core/money.js';
import { getSetting } from './settings.js';
import { mirror } from './firestore.js';

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

/**
 * Statuses that cannot change again. A receipt in one of these is a permanent
 * record and is never rewritten.
 */
const SETTLED_STATUSES = new Set(['approved']);

/**
 * The arrival promise shown the moment the transfer is submitted.
 *
 * Stored on the receipt as text alongside the machine-readable timestamp, for
 * the same reason amounts are stored as cents *and* a display string: a receipt
 * printed today must not re-word itself tomorrow because a constant moved.
 */
const ARRIVAL_WINDOW_HOURS = 24;
const ARRIVAL_HINT = `Money will arrive within ${ARRIVAL_WINDOW_HOURS} hours.`;

/**
 * Exported so the wording the customer sees in the submit confirmation comes
 * from the same constant that is frozen into the receipt. Two copies of this
 * sentence would be free to drift apart.
 */
export { ARRIVAL_HINT, ARRIVAL_WINDOW_HOURS };

/** requested_at + the arrival window, as an ISO timestamp. */
function arrivalBy(requestedAt) {
  return new Date(new Date(requestedAt).getTime() + ARRIVAL_WINDOW_HOURS * 3_600_000).toISOString();
}

/**
 * Build the receipt document from the current state of a transfer.
 *
 * Pure: it reads rows, it writes nothing. Both the mint and the refresh path go
 * through here, so a pending receipt and its settled successor are guaranteed to
 * be built the same way and cannot drift apart.
 *
 * `receiptNumber` and `issuedAt` are passed in rather than derived, because a
 * refresh must preserve the identity the customer was already given.
 */
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
      // The commitment made at submit time. Kept on the document even after the
      // money lands, because it records what the customer was promised and
      // whether that promise was met.
      expectedArrivalBy: arrivalBy(transfer.requested_at),
      arrivalHint: ARRIVAL_HINT,
      // True once the document can no longer change.
      final: settled,
    },
    recipient: {
      name: transfer.recipient_name,
      accountNumber: transfer.recipient_account_number,
      bank: transfer.recipient_bank_name,
      routingNumber: transfer.recipient_routing_number,
      iban: transfer.recipient_iban,
      swiftBic: transfer.recipient_swift_bic,
      country: transfer.recipient_country,
    },
    amounts: {
      // Stored as integer cents plus a display string. The integer is the
      // source of truth; the string exists so a historical receipt never
      // re-renders differently under a changed currency format.
      amountCents: transfer.amount_cents,
      feeCents: transfer.fee_cents,
      totalDebitCents: transfer.total_debit_cents,
      amountFormatted: formatCents(transfer.amount_cents),
      feeFormatted: formatCents(transfer.fee_cents),
      totalDebitFormatted: formatCents(transfer.total_debit_cents),
      // While pending nothing has been debited, so the receipt must not present
      // the total as money that has already left the account.
      debited: settled,
    },
    description: transfer.description,
    reviewedAt: transfer.reviewed_at,
    rejectionReason: transfer.rejection_reason ?? null,
  };
}

/** The transfer joined with the customer fields the receipt records. */
function loadTransferForReceipt(transferId) {
  return one(
    `SELECT t.*,
            c.full_name        AS customer_name,
            c.account_number   AS customer_account_number,
            c.email            AS customer_email
       FROM transfers t
       JOIN customers c ON c.id = t.customer_id
      WHERE t.id = ?`,
    [transferId],
  );
}

/**
 * Mint the receipt for a transfer.
 *
 * Called as soon as the customer confirms their transfer PIN, so it runs for a
 * transfer that is still `pending` as well as one that settled inline.
 * Idempotent: if a receipt already exists it is returned unchanged.
 *
 * @param {number} transferId
 * @returns {object|null} the receipt row including `payload`
 */
export function issueReceipt(transferId) {
  const existing = one('SELECT * FROM receipts WHERE transfer_id = ?', [transferId]);
  if (existing) return hydrate(existing);

  const transfer = loadTransferForReceipt(transferId);
  if (!transfer) throw new Error(`Cannot issue a receipt: transfer ${transferId} does not exist`);

  // Rejected and cancelled transfers never mint a fresh receipt: they are only
  // ever reached by minting at submit time, or by rewriting an existing one.
  if (transfer.status !== 'pending' && transfer.status !== 'approved') {
    throw new Error(
      `Cannot issue a receipt: transfer ${transferId} is ${transfer.status}, which is not a state that issues one`,
    );
  }

  const receiptNumber = generateReceiptNumber();
  const issuedAt = nowIso();
  const payload = buildPayload(transfer, { receiptNumber, issuedAt });

  run(
    'INSERT INTO receipts (receipt_number, transfer_id, customer_id, payload_json, issued_at) VALUES (?, ?, ?, ?, ?)',
    [receiptNumber, transfer.id, transfer.customer_id, JSON.stringify(payload), issuedAt],
  );

  mirrorReceipt(transfer.id);

  // Returned hydrated, so every caller receives the same shape regardless of
  // whether the receipt already existed.
  return receiptForTransfer(transfer.id);
}

/**
 * Rewrite an existing receipt to match the transfer's current state.
 *
 * Runs when a pending transfer is approved, rejected or cancelled, so the
 * document the customer already holds stops claiming "Pending" once that is no
 * longer true.
 *
 * Refuses to touch a receipt whose transfer has already settled. That is the
 * freeze: once funds have moved, the snapshot is a permanent record and later
 * edits to a bank name or an address must not rewrite history.
 *
 * @param {number} transferId
 * @returns {object|null} the refreshed receipt, or null when there is none
 */
export function refreshReceipt(transferId) {
  const existing = one('SELECT * FROM receipts WHERE transfer_id = ?', [transferId]);
  if (!existing) return null;

  const current = hydrate(existing);
  if (current?.payload?.transaction?.final) return current;

  const transfer = loadTransferForReceipt(transferId);
  if (!transfer) return current;

  const payload = buildPayload(transfer, {
    // Identity the customer was already given, preserved verbatim.
    receiptNumber: current.receiptNumber,
    issuedAt: current.issuedAt,
  });

  run('UPDATE receipts SET payload_json = ? WHERE id = ?', [JSON.stringify(payload), existing.id]);

  mirrorReceipt(transferId);

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
export function receiptForTransfer(transferId) {
  return hydrate(one('SELECT * FROM receipts WHERE transfer_id = ?', [transferId]));
}

/**
 * Copy the stored receipt into the Firestore mirror.
 *
 * The row keeps `payload_json` verbatim but the mirror stores the parsed
 * document instead, so it is queryable field by field rather than as a blob.
 */
function mirrorReceipt(transferId) {
  const row = one('SELECT * FROM receipts WHERE transfer_id = ?', [transferId]);
  if (!row) return;
  const { payload_json, ...rest } = row;
  let payload = null;
  try {
    payload = JSON.parse(payload_json);
  } catch {
    payload = null;
  }
  mirror('receipts', row.id, { ...rest, payload });
}

/** Receipt owned by a specific customer - used by the customer portal so a
 *  customer can never read another customer's document by guessing an id. */
export function receiptForCustomerTransfer(transferId, customerId) {
  return hydrate(
    one('SELECT * FROM receipts WHERE transfer_id = ? AND customer_id = ?', [transferId, customerId]),
  );
}

/**
 * Paginated receipts for a customer, newest first.
 *
 * Settled transfers only. Every transfer now carries a receipt from submit time,
 * so without this filter the archive would list documents for money that never
 * left the account. This list answers "what has my account actually paid?".
 * A still-pending receipt is reached through the transfer detail page instead.
 */
export function listCustomerReceipts(customerId, { limit = 20, offset = 0 } = {}) {
  const rows = many(
    `SELECT r.id, r.receipt_number, r.transfer_id, r.issued_at,
            t.transfer_type, t.amount_cents, t.fee_cents, t.total_debit_cents,
            t.recipient_name, t.recipient_bank_name, t.status, t.reference_number
       FROM receipts r
       JOIN transfers t ON t.id = r.transfer_id
      WHERE r.customer_id = ? AND t.status = 'approved'
      ORDER BY r.issued_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
    [customerId, limit, offset],
  );

  const { total } = one(
    `SELECT COUNT(*) AS total
       FROM receipts r JOIN transfers t ON t.id = r.transfer_id
      WHERE r.customer_id = ? AND t.status = 'approved'`,
    [customerId],
  );

  return { rows, total };
}