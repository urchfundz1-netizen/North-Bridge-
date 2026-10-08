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
    const customer = findCustomerById(req.auth.actorId);
    const prepared = prepareTransfer(req.body, {
      customerId: customer.id,
      customerStatus: customer.status,
      isBalanceSufficient: (total) => getBalance(customer.id) >= total,
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
        balanceCents: getBalance(customer.id),
        balanceFormatted: formatCents(getBalance(customer.id)),
        bank: toBank(findBankById(prepared.recipientBankId)),
      },
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
 *   4. Persist atomically.
 */
router.post(
  '/',
  requireCsrf,
  validateBody(transferSchema),
  asyncHandler(async (req, res) => {
    const customer = findCustomerById(req.auth.actorId);

    // Status is checked after the PIN so an unrelated account-state error
    // cannot be used as an oracle to test credentials.
    const pinResult = await confirmTransferPin(customer, req.body.transferPin);
    if (!pinResult.ok) {
      // 403 rather than 401: the session is valid, the authorisation failed.
      throw forbidden(pinResult.message);
    }

    const prepared = prepareTransfer(req.body, {
      customerId: customer.id,
      customerStatus: customer.status,
      isBalanceSufficient: (total) => getBalance(customer.id) >= total,
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

    const { transfer, created, settledNow } = createTransfer({
      customer,
      prepared,
      idempotencyKey: req.body.idempotencyKey,
      request: req,
    });

    const rules = bankingRules();

    // The receipt comes straight back with the transfer so the customer sees
    // their numbered document immediately, without a second round trip that
    // could fail and leave them staring at an empty confirmation screen.
    const receipt = receiptForCustomerTransfer(transfer.id, customer.id);

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
    const { rows, total } = listCustomerTransfers(req.auth.actorId, {
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
    const { rows, total } = listCustomerReceipts(req.auth.actorId, { limit, offset });
    res.json(paginated(rows, total, { limit, offset }));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const transfer = findTransferForCustomer(Number(req.params.id), req.auth.actorId);
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
    const receipt = receiptForCustomerTransfer(transferId, req.auth.actorId);
    if (!receipt) {
      const transfer = findTransferForCustomer(transferId, req.auth.actorId);
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
    const customer = findCustomerById(req.auth.actorId);
    const { transfer } = cancelTransfer({ transferId: Number(req.params.id), customer, request: req });
    res.json({
      transfer: toTransfer(transfer),
      message: `Transfer ${transfer.reference_number} has been cancelled.`,
    });
  }),
);

/* -------------------------------------------------------------------------- */

export default router;