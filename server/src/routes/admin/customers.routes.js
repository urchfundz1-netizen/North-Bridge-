/**
 * Administrator customer management routes.
 *
 * Mounted at /api/admin/customers. This is the only place in the application
 * that can create accounts, change an account's status, or move money into an
 * account. Every such action writes an audit entry naming the administrator and
 * - for destructive actions - the reason given.
 */

import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';

import { attachAuth, requireAdmin, requireCsrf } from '../../middleware/auth.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import {
  customerListSchema,
  ledgerListSchema,
  adminCreateCustomerSchema,
  adminUpdateCustomerSchema,
  changeStatusSchema,
  fundAccountSchema,
  adjustBalanceSchema,
} from '../schemas.js';
import { toCustomerAdmin, toLedgerEntry, paginated } from '../serializers.js';
import {
  listCustomers,
  customerDetail,
  adminCreateCustomer,
  adminUpdateCustomer,
  changeAccountStatus,
  fundAccount,
  adjustBalance,
  findCustomerById,
} from '../../services/customer-service.js';
import { listEntries, summarise } from '../../services/ledger-service.js';
import { recordAudit, AUDIT_ACTIONS } from '../../services/audit.js';
import { mirrorCustomerById } from '../../services/firestore.js';
import { run, nowIso } from '../../db/connection.js';
import { config } from '../../core/config.js';
import { badRequest, notFound } from '../../core/errors.js';
import { parseAmountToCents } from '../../core/money.js';

const router = Router();

const AVATAR_DIR = path.join(config.uploadsDir, 'avatars');

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

/** Funding lookup accepts a partial account number. */
const lookupSchema = z.object({
  accountNumber: z.string().trim().min(3, 'Enter an account number.').max(34),
});

router.use(attachAuth('admin'), requireAdmin);

/* -------------------------------------------------------------------------- */
/* Directory                                                                  */
/* -------------------------------------------------------------------------- */

/** Paginated, searchable customer list. */
router.get(
  '/',
  validateQuery(customerListSchema),
  asyncHandler(async (req, res) => {
    const { limit, offset, status, accountType, search } = req.validatedQuery;
    const { rows, total } = listCustomers({ limit, offset, status, accountType, search });
    res.json(paginated(rows.map(toCustomerAdmin), total, { limit, offset }));
  }),
);

/** Resolve a partial account number to matching customers - funding lookup. */
router.get(
  '/lookup',
  validateQuery(lookupSchema),
  asyncHandler(async (req, res) => {
    const { accountNumber } = req.validatedQuery;
    const found = listCustomers({ search: accountNumber, limit: 10 });
    res.json({ matches: found.rows.map(toCustomerAdmin) });
  }),
);

/**
 * Full customer record: profile, balances, transfers, funding history and
 * statement totals.
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const detail = customerDetail(Number(req.params.id));
    if (!detail) throw notFound('Customer not found.');

    const customer = detail.customer;
    res.json({
      customer: toCustomerAdmin(customer),
      transfers: detail.transfers.map((row) => ({
        id: row.id,
        referenceNumber: row.reference_number,
        transferType: row.transfer_type,
        recipientName: row.recipient_name,
        recipientBank: row.recipient_bank_name,
        amountCents: row.amount_cents,
        feeCents: row.fee_cents,
        status: row.status,
        requestedAt: row.requested_at,
      })),
      fundingHistory: detail.funding.map((row) => ({
        id: row.id,
        amountCents: row.amount_cents,
        balanceAfterCents: row.balance_after_cents,
        description: row.description,
        reference: row.reference_number,
        administeredBy: row.admin_name,
        administeredByEmail: row.admin_email,
        createdAt: row.created_at,
      })),
      summary: detail.summary,
    });
  }),
);

/** Paginated statement for one customer. */
router.get(
  '/:id/transactions',
  validateQuery(ledgerListSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!findCustomerById(id)) throw notFound('Customer not found.');

    const { limit, offset, entryType } = req.validatedQuery;
    const { rows, total } = listEntries(id, {
      limit,
      offset,
      entryType: entryType === 'all' ? null : entryType,
    });

    res.json({ ...paginated(rows.map(toLedgerEntry), total, { limit, offset }), summary: summarise(id) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Account lifecycle                                                          */
/* -------------------------------------------------------------------------- */

/** Create a customer account on the customer's behalf. */
router.post(
  '/',
  requireCsrf,
  validateBody(adminCreateCustomerSchema),
  asyncHandler(async (req, res) => {
    const { customer, generatedTransferPin } = await adminCreateCustomer(req.body, req.auth.actor, req);

    res.status(201).json({
      customer: toCustomerAdmin(customer),
      // Shown once so the admin can pass it on out-of-band; it is not stored
      // anywhere retrievable, because only its hash was ever persisted.
      generatedTransferPin,
      message: `Account ${customer.account_number} has been created.`,
    });
  }),
);

/** Edit customer information. */
router.patch(
  '/:id',
  requireCsrf,
  validateBody(adminUpdateCustomerSchema),
  asyncHandler(async (req, res) => {
    const updated = adminUpdateCustomer(Number(req.params.id), req.body, req.auth.actor, req);
    res.json({ customer: toCustomerAdmin(updated), message: 'Customer details updated.' });
  }),
);

/**
 * Lock, freeze, disable, or re-enable an account.
 * A reason is mandatory and is recorded alongside the action.
 */
router.post(
  '/:id/status',
  requireCsrf,
  validateBody(changeStatusSchema),
  asyncHandler(async (req, res) => {
    const updated = changeAccountStatus({
      customerId: Number(req.params.id),
      status: req.body.status,
      reason: req.body.reason,
      admin: req.auth.actor,
      request: req,
    });

    res.json({
      customer: toCustomerAdmin(updated),
      message: `Account ${updated.account_number} is now ${updated.status}.`,
    });
  }),
);

/** Upload or replace a customer's profile picture. */
router.post(
  '/:id/picture',
  requireCsrf,
  upload.single('picture'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const customer = findCustomerById(id);
    if (!customer) throw notFound('Customer not found.');
    if (!req.file) throw badRequest('Select an image to upload.');

    const extension = ALLOWED_IMAGE_TYPES.get(req.file.mimetype);
    const filename = `customer-${id}-${randomBytes(8).toString('hex')}${extension}`;

    await fs.mkdir(AVATAR_DIR, { recursive: true });
    await fs.writeFile(path.join(AVATAR_DIR, filename), req.file.buffer);

    const previous = customer.profile_picture;
    if (previous && path.basename(previous) === previous) {
      fs.unlink(path.join(AVATAR_DIR, previous)).catch(() => {});
    }

    const profilePicture = `/uploads/avatars/${filename}`;
    run('UPDATE customers SET profile_picture = ?, updated_at = ? WHERE id = ?', [
      profilePicture,
      nowIso(),
      id,
    ]);
    mirrorCustomerById(id);

    recordAudit({
      actorType: 'admin',
      actorId: req.auth.actor.id,
      actorEmail: req.auth.actor.email,
      action: AUDIT_ACTIONS.CUSTOMER_AVATAR_UPDATED,
      targetType: 'customer',
      targetId: id,
      targetLabel: customer.account_number,
      reason: 'Updated by administrator',
      request: req,
    });

    res.json({ profilePicture, message: 'Profile picture updated.' });
  }),
);

/* -------------------------------------------------------------------------- */
/* Funding                                                                    */
/* -------------------------------------------------------------------------- */

/** Credit funds to a customer account. */
router.post(
  '/:id/fund',
  requireCsrf,
  validateBody(fundAccountSchema),
  asyncHandler(async (req, res) => {
    const amountCents = parseAmountToCents(req.body.amount);

    const result = fundAccount({
      customerId: Number(req.params.id),
      amountCents,
      description: req.body.description,
      reference: req.body.reference,
      admin: req.auth.actor,
      request: req,
    });

    res.json({
      customer: toCustomerAdmin(result.customer),
      funding: {
        amountCents,
        balanceBeforeCents: result.balanceAfterCents - amountCents,
        balanceAfterCents: result.balanceAfterCents,
        description: req.body.description ?? null,
        reference: req.body.reference ?? null,
        createdAt: nowIso(),
      },
      message: `Funded ${req.body.amount}. New balance ${result.customer.balance_cents / 100}.`,
    });
  }),
);

/** Manual debit/credit correction. Never silently changes a balance. */
router.post(
  '/:id/adjust',
  requireCsrf,
  validateBody(adjustBalanceSchema),
  asyncHandler(async (req, res) => {
    const signed = req.body.amount.trim().replace(',', '.');
    const negative = signed.startsWith('-');
    const amountCents = parseAmountToCents(signed.replace(/^[+-]/, ''));
    const delta = negative ? -amountCents : amountCents;

    const result = adjustBalance({
      customerId: Number(req.params.id),
      amountCents: delta,
      reason: req.body.reason,
      admin: req.auth.actor,
      request: req,
    });

    res.json({
      customer: toCustomerAdmin(result.customer),
      message: `Balance adjusted by ${req.body.amount}.`,
    });
  }),
);

export default router;