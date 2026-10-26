/**
 * Customer transfer routes.
 *
 * Mounted at /api/transfers.
 *
 * A transfer is only ever created after the customer supplies their transfer
 * PIN, which is verified on the server against a hash that is distinct from the
 * login password hash. The PIN check happens inside the request handler, before
 * any row is written.
 */

import { Router } from 'express';
import {
  attachAuth,
  requireCustomer,
  requireCsrf,
} from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { transferSchema, transferQuoteSchema, transferListSchema } from './schemas.js';
import { toTransfer, toBank, paginated } from './serializers.js';
import {
  prepareTransfer,
  confirmTransferPin,
  createTransfer,
  cancelTransfer,
  listCustomerTransfers,
  findTransferForCustomer,
} from '../services/transfer-service.js';
import { createTransferChallenge, verifyTransferChallenge } from '../services/otp-service.js';
import { AUDIT_ACTIONS, recordAudit } from '../services/audit.js';
import {
  receiptForCustomerTransfer,
  listCustomerReceipts,
  ARRIVAL_HINT,
} from '../services/receipt-service.js';
import { findBankById } from '../services/bank-service.js';
import { bankingRules } from '../services/settings.js';
import { findCustomerById } from '../services/customer-service.js';
import { getBalance } from '../services/ledger-service.js';
import { forbidden, notFound, conflict } from '../core/errors.js';
import { formatCents } from '../core/money.js';

const router = Router();

router.use(attachAuth('customer'), requireCustomer);

const TRANSFER_OTP_MESSAGES = {
  invalid: 'This one-time code is invalid or has already been used. Request a new code.',
  expired: 'This one-time code has expired. Request a new code.',
  mismatch: 'Incorrect one-time code. Check the code and try again.',
  too_many_attempts: 'Too many incorrect codes. Request a new code.',
};

/* -------------------------------------------------------------------------- */
/* Fee quote                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Price a transfer without creating it, so the customer sees the fee before
 * committing. Uses exactly the same validation as the real submission, so the
 * quote cannot disagree with what the server will accept.
 */
router.post(
  '/quote',
  requireCsrf,
  validateBody(transferQuoteSchema),
  asyncHandler(async (req, res) => {
    const customer = await findCustomerById(req.auth.actorId);
    const balance = await getBalance(customer.id);
    const prepared = await prepareTransfer(req.body, {
      customerId: customer.id,
      customerStatus: customer.status,
      isBalanceSufficient: (total) => balance >= total,
    });

    res.json({
      quote: {
        amountCents: prepared.amountCents,
        amountFormatted: formatCents(prepared.amountCents),
        feeCents: prepared.feeCents,
        feeFormatted: formatCents(prepared.feeCents),
        totalDebitCents: prepared.totalDebitCents,
        totalDebitFormatted: formatCents(prepared.totalDebitCents),
        requiresApproval: prepared.requiresApproval,
        balanceCents: balance,
        balanceFormatted: formatCents(balance),
        bank: toBank(await findBankById(prepared.recipientBankId)),
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* One-time code                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Request the 8-digit code that authorises the next transfer.
 *
 * The code is never returned here: it is read back from the admin console and
 * relayed to the customer, exactly like the sign-in code. Minting a new code
 * does not invalidate an older pending one, but only the code supplied with the
 * final submission is consumed.
 */
router.post(
  '/otp',
  requireCsrf,
  asyncHandler(async (req, res) => {
    const customer = await findCustomerById(req.auth.actorId);
    const challenge = await createTransferChallenge(customer);

    await recordAudit({
      actorType: 'customer',
      actorId: customer.id,
      actorEmail: customer.email,
      action: AUDIT_ACTIONS.TRANSFER_OTP_REQUESTED,
      targetType: 'customer',
      targetId: customer.id,
      targetLabel: customer.account_number,
      metadata: { stage: 'transfer_otp_requested' },
      request: req,
    });

    res.status(201).json({
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Submit a transfer.
 *
 * Order of operations matters:
 *   1. Validate shape (schema).
 *   2. Verify the transfer PIN - no money-affecting state changes before this.
 *   3. Validate business rules (limits, bank support, funds).
 *   4. Verify and consume the one-time code requested for this transfer.
 *   5. Persist atomically.
 *
 * The code is checked after validation so a rejected request does not burn the
 * customer's code and force them to ask an administrator for another one.
 */
router.post(
  '/',
  requireCsrf,
  validateBody(transferSchema),
  asyncHandler(async (req, res) => {
    const customer = await findCustomerById(req.auth.actorId);

    // Status is checked after the PIN so an unrelated account-state error
    // cannot be used as an oracle to test credentials.
    const pinResult = await confirmTransferPin(customer, req.body.transferPin);
    if (!pinResult.ok) {
      // 403 rather than 401: the session is valid, the authorisation failed.
      throw forbidden(pinResult.message);
    }

    const balance = await getBalance(customer.id);
    const prepared = await prepareTransfer(req.body, {
      customerId: customer.id,
      customerStatus: customer.status,
      isBalanceSufficient: (total) => balance >= total,
    });

    // Business rule: only an active account may move money.
    if (customer.status !== 'active') {
      const messages = {
        locked: 'Your account is locked. Please contact Northbridge support.',
        frozen: 'Your account is frozen. Outgoing transfers are temporarily unavailable.',
        disabled: 'Your account has been disabled. Please contact Northbridge support.',
      };
      throw forbidden(messages[customer.status] ?? 'This account cannot make transfers.');
    }

    const otpResult = await verifyTransferChallenge(
      req.body.otpChallengeId,
      req.body.otpCode,
      customer.id,
    );
    if (!otpResult.ok) {
      throw forbidden(TRANSFER_OTP_MESSAGES[otpResult.reason] ?? TRANSFER_OTP_MESSAGES.invalid);
    }

    const { transfer, created, settledNow } = await createTransfer({
      customer,
      prepared,
      idempotencyKey: req.body.idempotencyKey,
      request: req,
    });

    const rules = bankingRules();

    // The receipt comes straight back with the transfer so the customer sees
    // their numbered document immediately, without a second round trip that
    // could fail and leave them staring at an empty confirmation screen.
    const receipt = await receiptForCustomerTransfer(transfer.id, customer.id);

    res.status(created ? 201 : 200).json({
      transfer: toTransfer(transfer),
      receipt,
      // The UI needs to explain the outcome precisely: settled immediately, or
      // queued for administrator review.
      outcome: settledNow
        ? {
            state: 'completed',
            message: rules.requireApproval
              ? 'Transfer completed.'
              : `Your transfer of ${formatCents(transfer.amount_cents)} has been sent to ${transfer.recipient_name}.`,
          }
        : {
            state: 'pending',
            message: `Your transfer of ${formatCents(transfer.amount_cents)} has been submitted. ${ARRIVAL_HINT}`,
          },
      rules,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* List / detail / cancel / receipt                                           */
/* -------------------------------------------------------------------------- */

router.get(
  '/',
  validateQuery(transferListSchema),
  asyncHandler(async (req, res) => {
    const { limit, offset, status, search } = req.validatedQuery;
    const { rows, total } = await listCustomerTransfers(req.auth.actorId, {
      limit,
      offset,
      status,
      search,
    });
    res.json(paginated(rows.map((row) => toTransfer(row)), total, { limit, offset }));
  }),
);

/** Transfer history filtered to those with a receipt. */
router.get(
  '/receipts',
  validateQuery(transferListSchema),
  asyncHandler(async (req, res) => {
    const { limit, offset } = req.validatedQuery;
    const { rows, total } = await listCustomerReceipts(req.auth.actorId, { limit, offset });
    res.json(paginated(rows, total, { limit, offset }));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const transfer = await findTransferForCustomer(Number(req.params.id), req.auth.actorId);
    if (!transfer) throw notFound('Transfer not found.');
    res.json({ transfer: toTransfer(transfer) });
  }),
);

/**
 * Receipt for a transfer. Scoped by customer id so a guessed transfer id
 * belonging to someone else returns 404 rather than leaking the document.
 *
 * A receipt exists from the moment the transfer was submitted, so the pending
 * case is served here rather than refused. The `conflict` below is now only a
 * safety net for a transfer that somehow has no document yet.
 */
router.get(
  '/:id/receipt',
  asyncHandler(async (req, res) => {
    const transferId = Number(req.params.id);
    const receipt = await receiptForCustomerTransfer(transferId, req.auth.actorId);
    if (!receipt) {
      const transfer = await findTransferForCustomer(transferId, req.auth.actorId);
      if (!transfer) throw notFound('Transfer not found.');
      throw conflict('No receipt has been issued for this transfer.');
    }
    res.json({ receipt });
  }),
);

/** Withdraw a pending transfer. Only possible while it is still unreviewed. */
router.post(
  '/:id/cancel',
  requireCsrf,
  asyncHandler(async (req, res) => {
    const customer = await findCustomerById(req.auth.actorId);
    const { transfer } = await cancelTransfer({ transferId: Number(req.params.id), customer, request: req });
    res.json({
      transfer: toTransfer(transfer),
      message: `Transfer ${transfer.reference_number} has been cancelled.`,
    });
  }),
);

/* -------------------------------------------------------------------------- */

export default router;