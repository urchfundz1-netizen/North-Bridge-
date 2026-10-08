/**
 * Transfer lifecycle: request -> approve / reject / cancel.
 *
 * Status transitions are one-way and guarded:
 *
 *     pending ──approve──> approved   (settles: debits balance, writes receipt)
 *            ──reject────> rejected   (no money moves)
 *            ──cancel────> cancelled  (customer withdraws, only while pending)
 *
 * `approve` is the delicate one. It runs inside a single IMMEDIATE
 * transaction and performs a conditional UPDATE
 * (`WHERE status = 'pending'`), then relies on the
 * `UNIQUE (transfer_id, entry_type)` ledger constraint. Together those two mean
 * that even if two administrators click Approve simultaneously, and even if an
 * attacker replays the HTTP request, the second attempt changes zero rows and
 * rolls back.
 */

import { one, many, run, transaction, nowIso } from '../db/connection.js';
import { badRequest, conflict, forbidden, notFound, validationFailed } from '../core/errors.js';
import { generateTransferReference, generateIdempotencyKey } from '../core/identifiers.js';
import { verifySecret } from '../core/crypto.js';
import { parseAmountToCents } from '../core/money.js';
import { bankingRules } from './settings.js';
import { postEntry, ENTRY_TYPES, getBalance } from './ledger-service.js';
import { issueReceipt, refreshReceipt } from './receipt-service.js';
import { AUDIT_ACTIONS, recordAudit } from './audit.js';
import { mirrorRow, mirrorCustomerById, mirrorLedgerEntriesForTransfer } from './firestore.js';

/** Transfer types the customer portal offers. */
export const TRANSFER_TYPES = ['local', 'international', 'wire'];

/** Fields each transfer type requires beyond the common set. */
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

/**
 * Canonical form of a bank identifier.
 *
 * Routing numbers and IBANs are written with spaces or hyphens for legibility, so
 * "0210 0002 1" and "021000021" have to compare equal for the per-bank length rule
 * to behave. Removing separators here keeps the stored, receipted and validated
 * value identical.
 */
function normalizeIdentifier(value) {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '').trim() : '';
}

/**
 * Validate a transfer request and compute the fee.
 *
 * Split from creation so the UI can quote a fee before the customer commits.
 *
 * @returns {object} normalised transfer input
 */
export function prepareTransfer(input, { customerId, customerStatus, isBalanceSufficient } = {}) {
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

  // Destination bank must exist, be active, and support this transfer type.
  const bank = one('SELECT * FROM banks WHERE id = ?', [input.recipientBankId ?? -1]);
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

  // Routing number length is per-bank, so honour whatever the admin configured.
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

  // Customers type IBANs in groups of four for legibility, so normalise before
  // checking length. The stored and receipted value is the unbroken form.
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
 * Verify the customer's transfer PIN.
 *
 * The PIN is deliberately a separate secret from the login password and is
 * never compared against it. Repeated failures lock the PIN (not just the IP)
 * so guessing cannot succeed by rotating source addresses.
 *
 * @returns {{ ok: true } | { ok: false, message: string }}
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
    // Reset the failure counter and clear any lock.
    run(
      'UPDATE customers SET transfer_pin_failed_attempts = 0, transfer_pin_locked_until = NULL, updated_at = ? WHERE id = ?',
      [now, customer.id],
    );
    return { ok: true };
  }

  const attempts = (customer.transfer_pin_failed_attempts ?? 0) + 1;
  const shouldLock = attempts >= PIN_MAX_FAILURES;
  run(
    `UPDATE customers
        SET transfer_pin_failed_attempts = ?,
            transfer_pin_locked_until = ?,
            updated_at = ?
      WHERE id = ?`,
    [attempts, shouldLock ? lockoutUntil() : null, now, customer.id],
  );

  recordAudit({
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
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Create a transfer request.
 *
 * When the banking rules require approval the money is NOT debited now; the row
 * is simply `pending` and an administrator settles it later. When approval is
 * switched off, the transfer settles inline through the same code path used by
 * `approve`, so there is only one implementation of settlement.
 */
export function createTransfer({ customer, prepared, idempotencyKey, request }) {
  const key = idempotencyKey?.trim() || generateIdempotencyKey();
  const referenceNumber = generateTransferReference();

  const requiresApproval = prepared.requiresApproval;
  const status = requiresApproval ? 'pending' : 'approved';

  const result = transaction((db) => {
    // Idempotent retry: if this key was already used, return the original
    // transfer instead of creating a duplicate money movement.
    const existing = db
      .prepare('SELECT * FROM transfers WHERE customer_id = ? AND idempotency_key = ?')
      .get(customer.id, key);
    if (existing) return { transfer: existing, created: false, settledNow: false };

    const inserted = db
      .prepare(
        `INSERT INTO transfers
           (reference_number, customer_id, transfer_type, recipient_name,
            recipient_account_number, recipient_bank_id, recipient_bank_name,
            recipient_routing_number, recipient_iban, recipient_swift_bic,
            recipient_country, amount_cents, fee_cents, total_debit_cents,
            description, status, requires_approval, idempotency_key, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        referenceNumber,
        customer.id,
        prepared.transferType,
        prepared.recipientName,
        prepared.recipientAccountNumber,
        prepared.recipientBankId,
        prepared.recipientBankName,
        prepared.recipientRoutingNumber,
        prepared.recipientIban,
        prepared.recipientSwiftBic,
        prepared.recipientCountry,
        prepared.amountCents,
        prepared.feeCents,
        prepared.totalDebitCents,
        prepared.description,
        status,
        requiresApproval ? 1 : 0,
        key,
        requiresApproval ? null : nowIso(),
      );

    const transferId = Number(inserted.lastInsertRowid);

    if (requiresApproval) {
      const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
      return { transfer, created: true, settledNow: false };
    }

    // Approval not required: settle inline. Wrapping the settle call in a
    // SAVEPOINT keeps the outer transaction semantics intact.
    db.exec('SAVEPOINT settle_inline');
    try {
      settleWithin(db, transferId);
      db.exec('RELEASE settle_inline');
    } catch (error) {
      db.exec('ROLLBACK TO settle_inline');
      db.exec('RELEASE settle_inline');
      throw error;
    }

    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
    return { transfer, created: true, settledNow: true };
  });

  if (result.created) {
    recordAudit({
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

    // Mint the receipt now, whichever path the transfer took. The customer has
    // just confirmed their PIN, so they leave holding a numbered document
    // showing Pending and the promised arrival window rather than an empty
    // slot. When the transfer settled inline, status is already `approved` and
    // the document is born final.
    issueReceipt(result.transfer.id);

    // SQLite has committed; now propagate to the Firestore mirror.
    mirrorRow('transfers', result.transfer);
    mirrorLedgerEntriesForTransfer(result.transfer.id);
    if (result.settledNow) mirrorCustomerById(result.transfer.customer_id);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Settlement                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Debit the balance for a transfer. Must run inside a transaction.
 *
 * Assumes the caller has already guarded the status transition.
 */
function settleWithin(db, transferId) {
  const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
  if (!transfer) throw notFound('Transfer not found.');

  postEntry({
    customerId: transfer.customer_id,
    amountCents: -transfer.amount_cents,
    entryType: ENTRY_TYPES.TRANSFER_PRINCIPAL,
    transferId: transfer.id,
    description: `${labelFor(transfer.transfer_type)} to ${transfer.recipient_name} (${transfer.recipient_bank_name})`,
    referenceNumber: transfer.reference_number,
  });

  if (transfer.fee_cents > 0) {
    postEntry({
      customerId: transfer.customer_id,
      amountCents: -transfer.fee_cents,
      entryType: ENTRY_TYPES.TRANSFER_FEE,
      transferId: transfer.id,
      description: `Transfer fee for ${transfer.reference_number}`,
      referenceNumber: transfer.reference_number,
    });
  }

  return db
    .prepare('UPDATE transfers SET settled_at = ? WHERE id = ?')
    .run(nowIso(), transfer.id);
}

function labelFor(type) {
  return { local: 'Local transfer', international: 'International transfer', wire: 'Wire transfer' }[type] ?? 'Transfer';
}

/**
 * Approve a pending transfer: settle the money and issue a receipt.
 *
 * Idempotency guarantees, in order:
 *   1. `BEGIN IMMEDIATE` - serialises competing approvals.
 *   2. `UPDATE ... WHERE status = 'pending'` - if `changes !== 1` the transfer
 *      was already handled, so we abort without touching the balance.
 *   3. `UNIQUE (transfer_id, entry_type)` - a backstop at the storage layer.
 */
export function approveTransfer({ transferId, admin, note, request }) {
  const outcome = transaction((db) => {
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
    if (!transfer) throw notFound('Transfer not found.');

    if (transfer.status === 'approved') {
      return { transfer, alreadyApproved: true, balanceAfterCents: getBalance(transfer.customer_id) };
    }
    if (transfer.status !== 'pending') {
      throw conflict(`This transfer has already been ${transfer.status}.`);
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(transfer.customer_id);
    if (!customer) throw notFound('Customer account not found.');

    // The account may have been frozen or emptied since the request was made.
    // Re-check the live balance rather than trusting the snapshot from request time.
    if (customer.balance_cents < transfer.total_debit_cents) {
      throw conflict(
        `Cannot approve: the account currently holds ${(customer.balance_cents / 100).toFixed(2)} but this transfer needs ${(transfer.total_debit_cents / 100).toFixed(2)}.`,
      );
    }

    const claimed = db
      .prepare(
        `UPDATE transfers
            SET status = 'approved', reviewed_at = ?, reviewed_by_admin_id = ?, review_note = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(nowIso(), admin.id, note ?? null, transferId);

    if (claimed.changes !== 1) {
      // Lost the race. Abort the whole transaction so nothing is committed.
      throw conflict('This transfer was already reviewed by another administrator.');
    }

    settleWithin(db, transferId);

    const updated = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
    return { transfer: updated, alreadyApproved: false, balanceAfterCents: getBalance(transfer.customer_id) };
  });

  if (!outcome.alreadyApproved) {
    recordAudit({
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

    // The receipt is refreshed outside the transaction: it reads the freshly
    // committed rows, and a failure to build it cannot roll back settlement.
    // Refresh rather than issue - the customer already holds this document from
    // the moment they confirmed their PIN, and this is the write that turns it
    // from Pending to Approved and freezes it.
    outcome.receipt = refreshReceipt(outcome.transfer.id);

    mirrorRow('transfers', outcome.transfer);
    mirrorLedgerEntriesForTransfer(outcome.transfer.id);
    mirrorCustomerById(outcome.transfer.customer_id);
  }

  return outcome;
}

/** Reject a pending transfer. No money moves. */
export function rejectTransfer({ transferId, admin, reason, request }) {
  if (!reason || !reason.trim()) {
    throw validationFailed({ reason: 'A rejection reason is required.' });
  }

  const outcome = transaction((db) => {
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
    if (!transfer) throw notFound('Transfer not found.');

    if (transfer.status === 'rejected') {
      return { transfer, alreadyRejected: true };
    }
    if (transfer.status !== 'pending') {
      throw conflict(`This transfer has already been ${transfer.status}.`);
    }

    const claimed = db
      .prepare(
        `UPDATE transfers
            SET status = 'rejected', reviewed_at = ?, reviewed_by_admin_id = ?,
                review_note = ?, rejection_reason = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(nowIso(), admin.id, reason.trim(), reason.trim(), transferId);

    if (claimed.changes !== 1) {
      throw conflict('This transfer was already reviewed by another administrator.');
    }

    return { transfer: db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId), alreadyRejected: false };
  });

  if (!outcome.alreadyRejected) {
    recordAudit({
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

    // Without this the customer keeps a receipt promising delivery of a transfer
    // that no longer exists.
    outcome.receipt = refreshReceipt(outcome.transfer.id);

    mirrorRow('transfers', outcome.transfer);
  }

  return outcome;
}

/** Customer-initiated cancellation. Only allowed while pending. */
export function cancelTransfer({ transferId, customer, request }) {
  const outcome = transaction((db) => {
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
    if (!transfer) throw notFound('Transfer not found.');
    if (transfer.customer_id !== customer.id) {
      throw forbidden('You can only cancel your own transfers.');
    }
    if (transfer.status === 'cancelled') return { transfer, alreadyCancelled: true };
    if (transfer.status !== 'pending') {
      throw conflict(`A ${transfer.status} transfer can no longer be cancelled.`);
    }

    const claimed = db
      .prepare(
        `UPDATE transfers SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(nowIso(), transferId);

    if (claimed.changes !== 1) throw conflict('This transfer was already reviewed.');

    return { transfer: db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId), alreadyCancelled: false };
  });

  if (!outcome.alreadyCancelled) {
    recordAudit({
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

    outcome.receipt = refreshReceipt(outcome.transfer.id);

    mirrorRow('transfers', outcome.transfer);
  }

  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export function findTransferById(transferId) {
  return one(
    `SELECT t.*, c.full_name AS customer_name, c.account_number AS customer_account_number,
            c.email AS customer_email
       FROM transfers t
       JOIN customers c ON c.id = t.customer_id
      WHERE t.id = ?`,
    [transferId],
  );
}

export function findTransferForCustomer(transferId, customerId) {
  return one(
    `SELECT t.*, c.full_name AS customer_name, c.account_number AS customer_account_number,
            c.email AS customer_email
       FROM transfers t
       JOIN customers c ON c.id = t.customer_id
      WHERE t.id = ? AND t.customer_id = ?`,
    [transferId, customerId],
  );
}

/** Paginated transfers for one customer. */
export function listCustomerTransfers(customerId, { status, limit = 20, offset = 0 } = {}) {
  const clauses = ['t.customer_id = ?'];
  const params = [customerId];

  if (status && status !== 'all') {
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      throw badRequest('Unknown transfer status filter.');
    }
    clauses.push('t.status = ?');
    params.push(status);
  }

  params.push(limit, offset);
  const where = `WHERE ${clauses.join(' AND ')}`;

  const rows = many(
    `SELECT t.*, r.receipt_number
       FROM transfers t
       LEFT JOIN receipts r ON r.transfer_id = t.id
       ${where}
      ORDER BY t.requested_at DESC, t.id DESC
      LIMIT ? OFFSET ?`,
    params,
  );

  const { total } = one(
    `SELECT COUNT(*) AS total FROM transfers t ${where}`,
    status && status !== 'all' ? [customerId, status] : [customerId],
  );

  return { rows, total };
}

/** Paginated transfers across all customers, for the admin review queue. */
export function listTransfers({ status, search, limit = 20, offset = 0 } = {}) {
  const clauses = [];
  const params = [];

  if (status && status !== 'all') {
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      throw badRequest('Unknown transfer status filter.');
    }
    clauses.push('t.status = ?');
    params.push(status);
  }

  if (search) {
    clauses.push(
      '(t.reference_number LIKE ? OR t.recipient_name LIKE ? OR t.recipient_account_number LIKE ? OR c.account_number LIKE ? OR c.full_name LIKE ?)',
    );
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = many(
    `SELECT t.*, c.full_name AS customer_name, c.account_number AS customer_account_number,
            c.email AS customer_email, c.status AS customer_status
       FROM transfers t
       JOIN customers c ON c.id = t.customer_id
       ${where}
      ORDER BY (t.status = 'pending') DESC, t.requested_at DESC, t.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const { total } = one(
    `SELECT COUNT(*) AS total FROM transfers t JOIN customers c ON c.id = t.customer_id ${where}`,
    params,
  );

  return { rows, total };
}

/** Counts for the admin dashboard. */
export function transferStats() {
  const row = one(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        COALESCE(SUM(total_debit_cents) FILTER (WHERE status = 'pending'), 0) AS pending_value_cents,
        COALESCE(SUM(amount_cents) FILTER (WHERE status = 'approved'), 0)      AS settled_value_cents
      FROM transfers`,
  );
  return row ?? {};
}

/** Whether the customer currently has enough for `totalDebitCents`. */
export function hasSufficientFunds(customerId, totalDebitCents) {
  return getBalance(customerId) >= totalDebitCents;
}