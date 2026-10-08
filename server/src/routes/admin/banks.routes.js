/**
 * Administrator bank catalogue routes.
 *
 * Mounted at /api/admin/banks. Adding a bank here makes it selectable by
 * customers immediately - the transfer flow reads the catalogue at request
 * time rather than from a hard-coded list.
 *
 * Reads are open to any administrator; writes are restricted to `superadmin`,
 * because editing the catalogue changes the payment options offered to every
 * customer in the platform.
 */

import { Router } from 'express';
import { attachAuth, requireAdmin, requireCsrf, requireRole } from '../../middleware/auth.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import { bankSchema, bankListSchema } from '../schemas.js';
import { toBank } from '../serializers.js';
import { listBanks, createBank, updateBank, deactivateBank, findBankById } from '../../services/bank-service.js';
import { notFound } from '../../core/errors.js';

const router = Router();

router.use(attachAuth('admin'), requireAdmin);

/** Only a superadmin may change what customers can send money to. */
const requireSuperadmin = requireRole('superadmin');

/** The full catalogue, including retired banks. */
router.get(
  '/',
  validateQuery(bankListSchema),
  asyncHandler(async (req, res) => {
    const { includeInactive, transferType, search } = req.validatedQuery;
    const banks = listBanks({ includeInactive, transferType, search });
    res.json({ banks: banks.map(toBank), total: banks.length });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const bank = findBankById(Number(req.params.id));
    if (!bank) throw notFound('Bank not found.');
    res.json({ bank: toBank(bank) });
  }),
);

/** Adding a bank changes the customer-facing transfer options. */
router.post(
  '/',
  requireCsrf,
  requireSuperadmin,
  validateBody(bankSchema),
  asyncHandler(async (req, res) => {
    const bank = createBank(req.body, req.auth.actor, req);
    res.status(201).json({ bank: toBank(bank), message: `${bank.name} added to the bank catalogue.` });
  }),
);

router.patch(
  '/:id',
  requireCsrf,
  requireSuperadmin,
  validateBody(bankSchema.partial()),
  asyncHandler(async (req, res) => {
    const bank = updateBank(Number(req.params.id), req.body, req.auth.actor, req);
    res.json({ bank: toBank(bank), message: `${bank.name} updated.` });
  }),
);

/**
 * Retire a bank (soft delete). Settled transfers keep their snapshot of the
 * bank name, so historical records are unaffected.
 */
router.post(
  '/:id/deactivate',
  requireCsrf,
  requireSuperadmin,
  validateBody(bankSchema.pick({ reason: true })),
  asyncHandler(async (req, res) => {
    const bank = deactivateBank(Number(req.params.id), req.auth.actor, req.body.reason, req);
    res.json({ bank: toBank(bank), message: `${bank.name} is no longer available for new transfers.` });
  }),
);

export default router;