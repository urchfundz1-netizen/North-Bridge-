/**
 * Administrator transfer review routes.
 *
 * Mounted at /api/admin/transfers. This is the approval queue: pending
 * transfers are listed, opened for review, then approved or rejected.
 *
 * The double-settlement guarantee lives in `approveTransfer`, not here. This
 * layer only authorises the administrator and records the intent; the service
 * performs the guarded status transition and the conditional ledger writes.
 */

import { Router } from 'express';
import { attachAuth, requireAdmin, requireCsrf } from '../../middleware/auth.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import { transferListSchema, reviewTransferSchema } from '../schemas.js';
import { toTransfer, paginated } from '../serializers.js';
import {
  listTransfers,
  findTransferById,
  approveTransfer,
  rejectTransfer,
  transferStats,
} from '../../services/transfer-service.js';
import { receiptForTransfer } from '../../services/receipt-service.js';
import { notFound } from '../../core/errors.js';

const router = Router();

router.use(attachAuth('admin'), requireAdmin);

/* -------------------------------------------------------------------------- */
/* Queue                                                                      */
/* -------------------------------------------------------------------------- */

/** Counters for the admin dashboard. */
router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    res.json({ stats: transferStats() });
  }),
);

/** Paginated review queue. Defaults to pending, oldest first. */
router.get(
  '/',
  validateQuery(transferListSchema),
  asyncHandler(async (req, res) => {
    const { limit, offset, status, search } = req.validatedQuery;
    const { rows, total } = listTransfers({ limit, offset, status, search });
    res.json(paginated(rows.map((row) => toTransfer(row, { includeCustomer: true })), total, { limit, offset }));
  }),
);

/** Full detail for the review screen, including the receipt once issued. */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const transfer = findTransferById(Number(req.params.id));
    if (!transfer) throw notFound('Transfer not found.');
    res.json({
      transfer: toTransfer(transfer, { includeCustomer: true }),
      receipt: receiptForTransfer(transfer.id),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Approve: settle the transfer, debit the customer's balance, issue a receipt.
 *
 * Safe to call twice - the second call reports the existing state without
 * deducting again (see `approveTransfer`).
 */
router.post(
  '/:id/approve',
  requireCsrf,
  validateBody(reviewTransferSchema),
  asyncHandler(async (req, res) => {
    const result = approveTransfer({
      transferId: Number(req.params.id),
      admin: req.auth.actor,
      note: req.body.note,
      request: req,
    });

    res.json({
      transfer: toTransfer(result.transfer, { includeCustomer: true }),
      receipt: result.receipt ?? receiptForTransfer(result.transfer.id),
      alreadyProcessed: result.alreadyApproved,
      message: result.alreadyApproved
        ? `Transfer ${result.transfer.reference_number} was already approved. No further funds were moved.`
        : `Transfer ${result.transfer.reference_number} approved and settled.`,
    });
  }),
);

/** Reject: no money moves. A reason is required and is recorded. */
router.post(
  '/:id/reject',
  requireCsrf,
  validateBody(reviewTransferSchema),
  asyncHandler(async (req, res) => {
    const result = rejectTransfer({
      transferId: Number(req.params.id),
      admin: req.auth.actor,
      reason: req.body.reason,
      request: req,
    });

    res.json({
      transfer: toTransfer(result.transfer, { includeCustomer: true }),
      alreadyProcessed: result.alreadyRejected,
      message: result.alreadyRejected
        ? `Transfer ${result.transfer.reference_number} was already rejected.`
        : `Transfer ${result.transfer.reference_number} rejected. The customer's balance is unchanged.`,
    });
  }),
);

/** Receipt for any settled transfer, for the admin's records. */
router.get(
  '/:id/receipt',
  asyncHandler(async (req, res) => {
    const transfer = findTransferById(Number(req.params.id));
    if (!transfer) throw notFound('Transfer not found.');

    const receipt = receiptForTransfer(transfer.id);
    if (!receipt) {
      res.status(409).json({
        error: {
          code: 'no_receipt',
          message: 'A receipt is issued once the transfer has been approved.',
        },
      });
      return;
    }
    res.json({ receipt });
  }),
);

export default router;