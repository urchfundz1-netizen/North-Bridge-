/**
 * Transfer lifecycle: request -> approve / reject / cancel.
 *
 *     pending --approve--> approved  (settles: debits balance, writes receipt)
 *            --reject---> rejected  (no money moves)
 *            --cancel---> cancelled (customer withdraws, only while pending)
 *
 * `approve` runs inside a single Firestore transaction. The transfer is read
 * first and its status checked; because Firestore retries a transaction whose
 * read set changed, two simultaneous approvals serialise and the loser re-reads
 * `approved`. The ledger's per-transfer unique index is the storage-level
 * backstop. All reads happen before any writes, as Firestore requires.
 */

import {
  C,
  nowIso,
  getById,
  txnGetById,
  setById,
  readCounter,
  bumpCounter,
  checkUnique,
  claimUnique,
  txnSet,
  uniqueRef,
  snapRows,
  coll,
  transaction,
} from '../db/firestore.js';
import { badRequest, conflict, forbidden, notFound, validationFailed } from '../core/errors.js';
import { generateTransferReference, generateIdempotencyKey } from '../core/identifiers.js';
import { verifySecret } from '../core/crypto.js';
import { parseAmountToCents } from '../core/money.js';
import { bankingRules } from './settings.js';
import { postEntries, ENTRY_TYPES, getBalance } from './ledger-service.js';
import { issueReceipt, refreshReceipt } from './receipt-service.js';
import { AUDIT_ACTIONS, recordAudit } from './audit.js';

export const TRANSFER_TYPES = ['local', 'international', 'wire'];

const TYPE_REQUIREMENTS = {
  local: ['recipientRoutingNumber'],
  international: ['recipientCountry'],
  wire: ['recipientRoutingNumber', 'recipientSwiftBic'],
};

const PIN_MAX_FAILURES = 5;
const PIN_LOCKOUT_MINUTES = 15;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function normalizeIdentifier(value) {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '').trim() : '';
}

/**
 * Validate a transfer request and compute the fee.
 *
 * @returns {Promise<object>} normalised transfer input
 */
export async function prepareTransfer(input, { customerId, customerStatus, isBalanceSufficient } = {}) {
  const rules = bankingRules();

  const amountCents = parseAmountToCents(input.amount);

  if (amountCents < rules.minTransferCents) {
    throw validationFailed({
      amount: `The minimum transfer amount is ${(rules.minTransferCents / 100).toFixed(2)}.`,
    });
  }
  if (amountCents > rules.maxTransferCents) {
    throw validationFailed({
      amount: `The maximum single transfer amount is ${(rules.maxTransferCents / 100).toFixed(2)}.`,
    });
  }

  const feeCents = rules.transferFeeCents;
  const totalDebitCents = amountCents + feeCents;

  const transferType = input.transferType;
  if (!TRANSFER_TYPES.includes(transferType)) {
    throw validationFailed({ transferType: 'Choose a valid transfer type.' });
  }

  const bank = await getById(C.banks, input.recipientBankId ?? -1);
  if (!bank) {
    throw validationFailed({ recipientBankId: 'Select a recipient bank.' });
  }
  if (!bank.is_active) {
    throw validationFailed({
      recipientBankId: 'That bank is not currently available for transfers. Please choose another.',
    });
  }
  const typeColumn = {
    local: 'supports_local',
    international: 'supports_international',
    wire: 'supports_wire',
  }[transferType];
  if (!bank[typeColumn]) {
    throw validationFailed({
      recipientBankId: `${bank.name} does not support ${transferType} transfers.`,
    });
  }

  const routing = normalizeIdentifier(input.recipientRoutingNumber);
  if (routing) {
    if (!/^[A-Za-z0-9]{3,34}$/.test(routing)) {
      throw validationFailed({
        recipientRoutingNumber: 'Routing / SWIFT codes may only contain letters and digits.',
      });
    }
    if (bank.routing_number_length && routing.length !== bank.routing_number_length) {
      throw validationFailed({
        recipientRoutingNumber: `${bank.name} routing numbers are exactly ${bank.routing_number_length} characters.`,
      });
    }
  }

  const iban = normalizeIdentifier(input.recipientIban);
  if (iban && !/^[A-Za-z0-9]{15,34}$/.test(iban)) {
    throw validationFailed({ recipientIban: 'Enter a valid IBAN (15-34 letters and digits).' });
  }

  const required = TYPE_REQUIREMENTS[transferType] ?? [];
  for (const field of required) {
    const value = input[field];
    if (!value || !String(value).trim()) {
      const labels = {
        recipientRoutingNumber: 'a routing number',
        recipientCountry: 'a destination country',
        recipientSwiftBic: 'a SWIFT / BIC code',
      };
      throw validationFailed({ [field]: `${transferType} transfers require ${labels[field]}.` });
    }
  }

  if (typeof isBalanceSufficient === 'function' && customerId && !isBalanceSufficient(totalDebitCents)) {
    throw validationFailed({
      amount: 'Your available balance is not enough to cover this transfer plus the fee.',
    });
  }

  return {
    transferType,
    amountCents,
    feeCents,
    totalDebitCents,
    recipientName: input.recipientName.trim(),
    recipientAccountNumber: input.recipientAccountNumber.trim(),
    recipientBankId: bank.id,
    recipientBankName: bank.name,
    recipientRoutingNumber: routing || null,
    recipientIban: iban || null,
    recipientSwiftBic: (input.recipientSwiftBic ?? '').trim() || null,
    recipientCountry: (input.recipientCountry ?? bank.country).trim(),
    description: (input.description ?? '').trim(),
    requiresApproval: rules.requireApproval,
    customerStatus,
  };
}

/* -------------------------------------------------------------------------- */
/* Transfer-PIN confirmation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Verify the customer's transfer PIN. Repeated failures lock the PIN so
 * guessing cannot succeed by rotating source addresses.
 *
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function confirmTransferPin(customer, suppliedPin) {
  if (customer.transfer_pin_locked_until && customer.transfer_pin_locked_until > nowIso()) {
    const minutes = Math.max(
      1,
      Math.ceil((new Date(customer.transfer_pin_locked_until) - new Date()) / 60000),
    );
    return {
      ok: false,
      code: 'pin_locked',
      message: `Your transfer PIN is temporarily locked. Try again in ${minutes} minute(s).`,
    };
  }

  const valid = await verifySecret(String(suppliedPin ?? ''), customer.transfer_pin_hash);
  const now = nowIso();

  if (valid) {
    await setById(
      C.customers,
      customer.id,
      { transfer_pin_failed_attempts: 0, transfer_pin_locked_until: null, updated_at: now },
      { merge: true },
    );
    return { ok: true };
  }

  const attempts = (customer.transfer_pin_failed_attempts ?? 0) + 1;
  const shouldLock = attempts >= PIN_MAX_FAILURES;
  await setById(
    C.customers,
    customer.id,
    {
      transfer_pin_failed_attempts: attempts,
      transfer_pin_locked_until: shouldLock ? lockoutUntil() : null,
      updated_at: now,
    },
    { merge: true },
  );

  await recordAudit({
    actorType: 'customer',
    actorId: customer.id,
    actorEmail: customer.email,
    action: 'transfer.pin_failed',
    targetType: 'customer',
    targetId: customer.id,
    targetLabel: customer.account_number,
    metadata: { attempt: attempts, locked: shouldLock },
  });

  return {
    ok: false,
    code: shouldLock ? 'pin_locked' : 'pin_incorrect',
    message: shouldLock
      ? `Too many incorrect attempts. Your transfer PIN is locked for ${PIN_LOCKOUT_MINUTES} minutes.`
      : `Incorrect transfer PIN. ${PIN_MAX_FAILURES - attempts} attempt(s) remaining before your PIN is temporarily locked.`,
  };
}

function lockoutUntil() {
  return new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60_000).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Settlement helpers                                                         */
/* -------------------------------------------------------------------------- */

function labelFor(type) {
  return (
    { local: 'Local transfer', international: 'International transfer', wire: 'Wire transfer' }[type] ??
    'Transfer'
  );
}

/** Ledger entries that settle a transfer. */
function settlementEntries(transfer) {
  const entries = [
    {
      customerId: transfer.customer_id,
      amountCents: -transfer.amount_cents,
      entryType: ENTRY_TYPES.TRANSFER_PRINCIPAL,
      transferId: transfer.id,
      description: `${labelFor(transfer.transfer_type)} to ${transfer.recipient_name} (${transfer.recipient_bank_name})`,
      referenceNumber: transfer.reference_number,
    },
  ];
  if (transfer.fee_cents > 0) {
    entries.push({
      customerId: transfer.customer_id,
      amountCents: -transfer.fee_cents,
      entryType: ENTRY_TYPES.TRANSFER_FEE,
      transferId: transfer.id,
      description: `Transfer fee for ${transfer.reference_number}`,
      referenceNumber: transfer.reference_number,
    });
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Create a transfer request. When approval is required the money is not debited
 * now; the row is `pending`. Otherwise it settles inline through the same
 * settlement path used by `approve`.
 */
export async function createTransfer({ customer, prepared, idempotencyKey, request }) {
  const key = idempotencyKey?.trim() || generateIdempotencyKey();
  const referenceNumber = generateTransferReference();
  const requiresApproval = prepared.requiresApproval;
  const status = requiresApproval ? 'pending' : 'approved';
  const settledNow = !requiresApproval;

  const result = await transaction(async (txn) => {
    const idemKey = `transferIdem:${customer.id}:${key}`;

    // --- Reads --------------------------------------------------------------
    const idemSnap = await txn.get(uniqueRef(idemKey));
    if (idemSnap.exists) {
      const existing = await txnGetById(txn, C.transfers, idemSnap.data().ownerId);
      return { transfer: existing, created: false, settledNow: false };
    }

    const transferId = await readCounter(txn, C.transfers);
    await checkUnique(txn, `transferRef:${referenceNumber}`, transferId);

    const now = nowIso();
    const row = {
      reference_number: referenceNumber,
      customer_id: customer.id,
      transfer_type: prepared.transferType,
      recipient_name: prepared.recipientName,
      recipient_account_number: prepared.recipientAccountNumber,
      recipient_bank_id: prepared.recipientBankId,
      recipient_bank_name: prepared.recipientBankName,
      recipient_routing_number: prepared.recipientRoutingNumber,
      recipient_iban: prepared.recipientIban,
      recipient_swift_bic: prepared.recipientSwiftBic,
      recipient_country: prepared.recipientCountry,
      amount_cents: prepared.amountCents,
      fee_cents: prepared.feeCents,
      total_debit_cents: prepared.totalDebitCents,
      currency: 'USD',
      description: prepared.description,
      status,
      requires_approval: requiresApproval,
      idempotency_key: key,
      requested_at: now,
      reviewed_at: requiresApproval ? null : now,
      reviewed_by_admin_id: null,
      review_note: null,
      rejection_reason: null,
      settled_at: null,
      cancelled_at: null,
    };

    if (settledNow) {
      // postEntries reads first, then writes; safe to call before any write.
      await postEntries(settlementEntries({ id: transferId, ...row }), txn);
      row.settled_at = nowIso();
    }

    // --- Writes -------------------------------------------------------------
    bumpCounter(txn, C.transfers, transferId);
    claimUnique(txn, `transferRef:${referenceNumber}`, transferId);
    claimUnique(txn, idemKey, transferId);
    txnSet(txn, C.transfers, transferId, row);

    return { transfer: { id: transferId, ...row }, created: true, settledNow };
  });

  if (result.created) {
    await recordAudit({
      actorType: 'customer',
      actorId: customer.id,
      actorEmail: customer.email,
      action: AUDIT_ACTIONS.TRANSFER_REQUESTED,
      targetType: 'transfer',
      targetId: result.transfer.id,
      targetLabel: result.transfer.reference_number,
      metadata: {
        amountCents: prepared.amountCents,
        feeCents: prepared.feeCents,
        type: prepared.transferType,
        recipient: prepared.recipientName,
        recipientBank: prepared.recipientBankName,
        status: result.transfer.status,
      },
      request,
    });

    await issueReceipt(result.transfer.id);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Settlement                                                                 */
/* -------------------------------------------------------------------------- */

/** Approve a pending transfer: settle the money and refresh the receipt. */
export async function approveTransfer({ transferId, admin, note, request }) {
  const outcome = await transaction(async (txn) => {
    // --- Reads --------------------------------------------------------------
    const transfer = await txnGetById(txn, C.transfers, transferId);
    if (!transfer) throw notFound('Transfer not found.');

    if (transfer.status === 'approved') {
      const customer = await txnGetById(txn, C.customers, transfer.customer_id);
      return { transfer, alreadyApproved: true, balanceAfterCents: customer?.balance_cents ?? null };
    }
    if (transfer.status !== 'pending') {
      throw conflict(`This transfer has already been ${transfer.status}.`);
    }

    const customer = await txnGetById(txn, C.customers, transfer.customer_id);
    if (!customer) throw notFound('Customer account not found.');

    if ((customer.balance_cents ?? 0) < transfer.total_debit_cents) {
      throw conflict(
        `Cannot approve: the account currently holds ${(customer.balance_cents / 100).toFixed(2)} but this transfer needs ${(transfer.total_debit_cents / 100).toFixed(2)}.`,
      );
    }

    const now = nowIso();

    // postEntries reads first, then writes.
    const posted = await postEntries(settlementEntries(transfer), txn);

    // --- Writes -------------------------------------------------------------
    txnSet(
      txn,
      C.transfers,
      transferId,
      {
        status: 'approved',
        reviewed_at: now,
        reviewed_by_admin_id: admin.id,
        review_note: note ?? null,
        settled_at: now,
      },
      { merge: true },
    );

    const updated = {
      ...transfer,
      status: 'approved',
      reviewed_at: now,
      reviewed_by_admin_id: admin.id,
      review_note: note ?? null,
      settled_at: now,
    };
    return {
      transfer: updated,
      alreadyApproved: false,
      balanceAfterCents: posted[posted.length - 1]?.balanceAfterCents,
    };
  });

  if (!outcome.alreadyApproved) {
    await recordAudit({
      actorType: 'admin',
      actorId: admin.id,
      actorEmail: admin.email,
      action: AUDIT_ACTIONS.TRANSFER_APPROVED,
      targetType: 'transfer',
      targetId: outcome.transfer.id,
      targetLabel: outcome.transfer.reference_number,
      reason: note ?? null,
      metadata: {
        amountCents: outcome.transfer.amount_cents,
        feeCents: outcome.transfer.fee_cents,
        recipient: outcome.transfer.recipient_name,
        recipientBank: outcome.transfer.recipient_bank_name,
        customerAccount: outcome.transfer.customer_id,
        balanceAfterCents: outcome.balanceAfterCents,
      },
      request,
    });

    outcome.receipt = await refreshReceipt(outcome.transfer.id);
  }

  return outcome;
}

/** Reject a pending transfer. No money moves. */
export async function rejectTransfer({ transferId, admin, reason, request }) {
  if (!reason || !reason.trim()) {
    throw validationFailed({ reason: 'A rejection reason is required.' });
  }

  const outcome = await transaction(async (txn) => {
    const transfer = await txnGetById(txn, C.transfers, transferId);
    if (!transfer) throw notFound('Transfer not found.');

    if (transfer.status === 'rejected') return { transfer, alreadyRejected: true };
    if (transfer.status !== 'pending') {
      throw conflict(`This transfer has already been ${transfer.status}.`);
    }

    const now = nowIso();
    txnSet(
      txn,
      C.transfers,
      transferId,
      {
        status: 'rejected',
        reviewed_at: now,
        reviewed_by_admin_id: admin.id,
        review_note: reason.trim(),
        rejection_reason: reason.trim(),
      },
      { merge: true },
    );

    return {
      transfer: {
        ...transfer,
        status: 'rejected',
        reviewed_at: now,
        reviewed_by_admin_id: admin.id,
        review_note: reason.trim(),
        rejection_reason: reason.trim(),
      },
      alreadyRejected: false,
    };
  });

  if (!outcome.alreadyRejected) {
    await recordAudit({
      actorType: 'admin',
      actorId: admin.id,
      actorEmail: admin.email,
      action: AUDIT_ACTIONS.TRANSFER_REJECTED,
      targetType: 'transfer',
      targetId: outcome.transfer.id,
      targetLabel: outcome.transfer.reference_number,
      reason: reason.trim(),
      metadata: {
        amountCents: outcome.transfer.amount_cents,
        recipient: outcome.transfer.recipient_name,
        recipientBank: outcome.transfer.recipient_bank_name,
      },
      request,
    });

    outcome.receipt = await refreshReceipt(outcome.transfer.id);
  }

  return outcome;
}

/** Customer-initiated cancellation. Only allowed while pending. */
export async function cancelTransfer({ transferId, customer, request }) {
  const outcome = await transaction(async (txn) => {
    const transfer = await txnGetById(txn, C.transfers, transferId);
    if (!transfer) throw notFound('Transfer not found.');
    if (transfer.customer_id !== customer.id) {
      throw forbidden('You can only cancel your own transfers.');
    }
    if (transfer.status === 'cancelled') return { transfer, alreadyCancelled: true };
    if (transfer.status !== 'pending') {
      throw conflict(`A ${transfer.status} transfer can no longer be cancelled.`);
    }

    const now = nowIso();
    txnSet(txn, C.transfers, transferId, { status: 'cancelled', cancelled_at: now }, { merge: true });

    return { transfer: { ...transfer, status: 'cancelled', cancelled_at: now }, alreadyCancelled: false };
  });

  if (!outcome.alreadyCancelled) {
    await recordAudit({
      actorType: 'customer',
      actorId: customer.id,
      actorEmail: customer.email,
      action: AUDIT_ACTIONS.TRANSFER_CANCELLED,
      targetType: 'transfer',
      targetId: outcome.transfer.id,
      targetLabel: outcome.transfer.reference_number,
      metadata: { amountCents: outcome.transfer.amount_cents },
      request,
    });

    outcome.receipt = await refreshReceipt(outcome.transfer.id);
  }

  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

async function decorateWithCustomer(transfer) {
  if (!transfer) return null;
  const customer = await getById(C.customers, transfer.customer_id);
  return {
    ...transfer,
    customer_name: customer?.full_name ?? null,
    customer_account_number: customer?.account_number ?? null,
    customer_email: customer?.email ?? null,
    customer_status: customer?.status ?? null,
  };
}

export async function findTransferById(transferId) {
  return decorateWithCustomer(await getById(C.transfers, transferId));
}

export async function findTransferForCustomer(transferId, customerId) {
  const transfer = await getById(C.transfers, transferId);
  if (!transfer || transfer.customer_id !== customerId) return null;
  return decorateWithCustomer(transfer);
}

/** Paginated transfers for one customer. */
export async function listCustomerTransfers(customerId, { status, limit = 20, offset = 0 } = {}) {
  if (status && status !== 'all' && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
    throw badRequest('Unknown transfer status filter.');
  }

  const snap = await coll(C.transfers).where('customer_id', '==', customerId).get();
  let rows = snapRows(snap);
  if (status && status !== 'all') rows = rows.filter((row) => row.status === status);
  rows.sort((a, b) => {
    if (a.requested_at === b.requested_at) return b.id - a.id;
    return a.requested_at < b.requested_at ? 1 : -1;
  });
  const total = rows.length;
  rows = rows.slice(offset, offset + limit);

  const receiptSnap = await coll(C.receipts).where('customer_id', '==', customerId).get();
  const receiptByTransfer = new Map();
  receiptSnap.forEach((doc) => {
    const data = doc.data();
    receiptByTransfer.set(data.transfer_id, data.receipt_number);
  });
  rows = rows.map((row) => ({ ...row, receipt_number: receiptByTransfer.get(row.id) ?? null }));

  return { rows, total };
}

/** Paginated transfers across all customers, for the admin review queue. */
export async function listTransfers({ status, search, limit = 20, offset = 0 } = {}) {
  if (status && status !== 'all' && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
    throw badRequest('Unknown transfer status filter.');
  }

  const base = coll(C.transfers);
  const query = status && status !== 'all' ? base.where('status', '==', status) : base;
  const snap = await query.get();
  let rows = snapRows(snap);

  rows = await Promise.all(rows.map((row) => decorateWithCustomer(row)));

  if (search) {
    const needle = String(search).toLowerCase();
    rows = rows.filter((row) =>
      [
        row.reference_number,
        row.recipient_name,
        row.recipient_account_number,
        row.customer_account_number,
        row.customer_name,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }

  rows.sort((a, b) => {
    const pendingA = a.status === 'pending' ? 1 : 0;
    const pendingB = b.status === 'pending' ? 1 : 0;
    if (pendingA !== pendingB) return pendingB - pendingA;
    if (a.requested_at === b.requested_at) return b.id - a.id;
    return a.requested_at < b.requested_at ? 1 : -1;
  });

  const total = rows.length;
  return { rows: rows.slice(offset, offset + limit), total };
}

/** Counts for the admin dashboard. */
export async function transferStats() {
  const snap = await coll(C.transfers).get();
  const stats = {
    pending: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
    pending_value_cents: 0,
    settled_value_cents: 0,
  };
  snap.forEach((doc) => {
    const t = doc.data();
    if (t.status === 'pending') {
      stats.pending += 1;
      stats.pending_value_cents += t.total_debit_cents ?? 0;
    } else if (t.status === 'approved') {
      stats.approved += 1;
      stats.settled_value_cents += t.amount_cents ?? 0;
    } else if (t.status === 'rejected') {
      stats.rejected += 1;
    } else if (t.status === 'cancelled') {
      stats.cancelled += 1;
    }
  });
  return stats;
}

/** Whether the customer currently has enough for `totalDebitCents`. */
export async function hasSufficientFunds(customerId, totalDebitCents) {
  return (await getBalance(customerId)) >= totalDebitCents;
}
