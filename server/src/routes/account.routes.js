/**
 * Customer account routes.
 *
 * Mounted at /api/account. Everything here is scoped to the signed-in
 * customer: no route accepts a customer id, so a customer cannot read or
 * modify another customer's account by editing a request parameter.
 */

import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import multer from 'multer';

import { attachAuth, requireCustomer, requireCsrf, requireUsableAccount } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { updateProfileSchema, ledgerListSchema } from './schemas.js';
import { toCustomerSelf, toLedgerEntry, paginated } from './serializers.js';
import { updateOwnProfile, findCustomerById } from '../services/customer-service.js';
import { listEntries, summarise } from '../services/ledger-service.js';
import { bankingRules } from '../services/settings.js';
import { listBanks, findBankById } from '../services/bank-service.js';
import { listCustomerTransfers } from '../services/transfer-service.js';
import { listCustomerReceipts } from '../services/receipt-service.js';
import { recordAudit, AUDIT_ACTIONS } from '../services/audit.js';
import { mirrorCustomerById } from '../services/firestore.js';
import { run, nowIso } from '../db/connection.js';
import { config } from '../core/config.js';
import { badRequest, notFound } from '../core/errors.js';

const router = Router();

const AVATAR_DIR = path.join(config.uploadsDir, 'avatars');

/**
 * Avatar uploads.
 *
 * Multer buffers the file in memory and it is written only after both the
 * declared MIME type and the final extension have been checked, so a renamed
 * `.svg`/`.exe` cannot get script execution from a user-supplied path. The
 * stored filename is generated server-side and never derived from user input.
 */
const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.banking.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(badRequest('Profile pictures must be a JPG, PNG or WebP image.'));
      return;
    }
    cb(null, true);
  },
});

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

router.use(attachAuth('customer'), requireCustomer);

/** Current customer profile. */
router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    res.json({
      customer: toCustomerSelf(findCustomerById(req.auth.actorId)),
      rules: bankingRules(),
    });
  }),
);

router.patch(
  '/profile',
  requireCsrf,
  requireUsableAccount,
  validateBody(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const updated = updateOwnProfile(req.auth.actorId, req.body, req);
    res.json({ customer: toCustomerSelf(updated), message: 'Your profile has been updated.' });
  }),
);

/** Replace the profile picture. */
router.post(
  '/profile/picture',
  requireCsrf,
  requireUsableAccount,
  upload.single('picture'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Select an image to upload.');

    const extension = ALLOWED_IMAGE_TYPES.get(req.file.mimetype);
    const filename = `customer-${req.auth.actorId}-${randomBytes(8).toString('hex')}${extension}`;

    await fs.mkdir(AVATAR_DIR, { recursive: true });
    await fs.writeFile(path.join(AVATAR_DIR, filename), req.file.buffer);

    // Best-effort cleanup of the superseded image. Failure is deliberately
    // ignored: a stale avatar is cosmetic and must not fail the upload.
    const previous = req.auth.actor.profile_picture;
    if (previous && path.basename(previous) === previous) {
      fs.unlink(path.join(AVATAR_DIR, previous)).catch(() => {});
    }

    const profilePicture = `/uploads/avatars/${filename}`;
    run('UPDATE customers SET profile_picture = ?, updated_at = ? WHERE id = ?', [
      profilePicture,
      nowIso(),
      req.auth.actorId,
    ]);
    mirrorCustomerById(req.auth.actorId);

    recordAudit({
      actorType: 'customer',
      actorId: req.auth.actorId,
      actorEmail: req.auth.actor.email,
      action: AUDIT_ACTIONS.CUSTOMER_AVATAR_UPDATED,
      targetType: 'customer',
      targetId: req.auth.actorId,
      targetLabel: req.auth.actor.account_number,
      request: req,
    });

    res.json({ profilePicture, message: 'Your profile picture has been updated.' });
  }),
);

/* -------------------------------------------------------------------------- */
/* Dashboard & statement                                                      */
/* -------------------------------------------------------------------------- */

/** Everything the dashboard needs in one round trip. */
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const customerId = req.auth.actorId;

    const { rows: recent } = listEntries(customerId, { limit: 5 });
    const pending = listCustomerTransfers(customerId, { status: 'pending', limit: 5 });
    const receipts = listCustomerReceipts(customerId, { limit: 1 });

    res.json({
      customer: toCustomerSelf(findCustomerById(customerId)),
      recentTransactions: recent.map(toLedgerEntry),
      pendingTransfers: { total: pending.total, rows: pending.rows },
      statement: summarise(customerId),
      receiptCount: receipts.total,
      rules: bankingRules(),
    });
  }),
);

/** Paginated statement / transaction history. */
router.get(
  '/transactions',
  validateQuery(ledgerListSchema),
  asyncHandler(async (req, res) => {
    const { limit, offset, entryType } = req.validatedQuery;
    const { rows, total } = listEntries(req.auth.actorId, {
      limit,
      offset,
      entryType: entryType === 'all' ? null : entryType,
    });
    res.json(paginated(rows.map(toLedgerEntry), total, { limit, offset }));
  }),
);

/* -------------------------------------------------------------------------- */
/* Bank directory                                                             */
/* -------------------------------------------------------------------------- */

/** Banks the customer may choose, scoped to active banks that support the type. */
router.get(
  '/banks',
  asyncHandler(async (req, res) => {
    const transferType = ['local', 'international', 'wire'].includes(String(req.query.transferType))
      ? String(req.query.transferType)
      : null;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : null;

    const banks = listBanks({ includeInactive: false, transferType, search }).map((bank) => ({
      id: bank.id,
      name: bank.name,
      code: bank.code,
      country: bank.country,
      routingNumberLength: bank.routing_number_length,
    }));

    res.json({ banks, rules: bankingRules() });
  }),
);

router.get(
  '/banks/:id',
  asyncHandler(async (req, res) => {
    const bank = findBankById(Number(req.params.id));
    if (!bank || !bank.is_active) throw notFound('That bank is not available.');
    res.json({
      bank: {
        id: bank.id,
        name: bank.name,
        code: bank.code,
        country: bank.country,
        routingNumberLength: bank.routing_number_length,
      },
    });
  }),
);

export default router;