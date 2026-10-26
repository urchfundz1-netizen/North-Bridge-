/**
 * One-time code administration.
 *
 * Read-only by design: challenges are produced by the sign-in and transfer
 * flows, never edited here. This is where an administrator reads back the
 * 6-digit code minted for a customer's pending sign-in or transfer and relays
 * it to them ("fetch the OTP").
 *
 * Mounted at /api/admin/otp.
 */

import { Router } from 'express';
import { z } from 'zod';
import { attachAuth, requireAdmin } from '../../middleware/auth.js';
import { validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import { toLoginChallenge, paginated } from '../serializers.js';
import { listChallenges, otpStats } from '../../services/otp-service.js';

const router = Router();

router.use(attachAuth('admin'), requireAdmin);

const listQuerySchema = z.object({
  status: z.string().trim().max(20).default('all'),
  purpose: z.enum(['all', 'login', 'transfer']).default('all'),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Challenge counts for the page header. */
router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    res.json(await otpStats());
  }),
);

/** The codes for pending sign-ins and transfers - newest first, code included. */
router.get(
  '/challenges',
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { status, purpose, search, limit, offset } = req.validatedQuery;
    const { rows, total } = await listChallenges({ status, purpose, search, limit, offset });
    res.json(paginated(rows.map(toLoginChallenge), total, { limit, offset }));
  }),
);

export default router;
