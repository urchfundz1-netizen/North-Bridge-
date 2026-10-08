/**
 * Audit log and system overview routes.
 *
 * Mounted at /api/admin. The audit log is read-only by design - there is no
 * create, update or delete route, and the table itself rejects those
 * operations at the database level.
 */

import { Router } from 'express';
import { z } from 'zod';
import { attachAuth, requireAdmin, requireCsrf, requireRole } from '../../middleware/auth.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import { auditListSchema } from '../schemas.js';
import { toAuditLog, paginated } from '../serializers.js';
import { many, one } from '../../db/connection.js';
import { recordAudit, AUDIT_ACTIONS } from '../../services/audit.js';
import { settingsSnapshot, bankingRules, setSetting } from '../../services/settings.js';
import { formatCents } from '../../core/money.js';
import { validationFailed } from '../../core/errors.js';

const router = Router();

router.use(attachAuth('admin'), requireAdmin);

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

/** Paginated, filterable audit trail. */
router.get(
  '/audit-logs',
  validateQuery(auditListSchema),
  asyncHandler(async (req, res) => {
    const { limit, offset, action, actorType, actorId, targetType, search } = req.validatedQuery;

    const clauses = [];
    const params = [];

    if (action) {
      clauses.push('action = ?');
      params.push(action);
    }
    if (actorType && actorType !== 'all') {
      clauses.push('actor_type = ?');
      params.push(actorType);
    }
    if (actorId) {
      clauses.push('actor_id = ?');
      params.push(actorId);
    }
    if (targetType) {
      clauses.push('target_type = ?');
      params.push(targetType);
    }
    if (search) {
      clauses.push(
        '(action LIKE ? OR actor_email LIKE ? OR target_label LIKE ? OR reason LIKE ? OR target_id LIKE ?)',
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = many(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    const { total } = one(`SELECT COUNT(*) AS total FROM audit_logs ${where}`, params);

    res.json(paginated(rows.map(toAuditLog), total, { limit, offset }));
  }),
);

/** Distinct action names, for populating the filter dropdown. */
router.get(
  '/audit-logs/actions',
  asyncHandler(async (_req, res) => {
    const rows = many('SELECT DISTINCT action FROM audit_logs ORDER BY action');
    res.json({ actions: rows.map((row) => row.action) });
  }),
);

/* -------------------------------------------------------------------------- */
/* System overview                                                            */
/* -------------------------------------------------------------------------- */

/** Headline numbers for the admin dashboard. */
router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const accounts = one(
      `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END), 0) AS active,
          COALESCE(SUM(CASE WHEN status = 'locked'   THEN 1 ELSE 0 END), 0) AS locked,
          COALESCE(SUM(CASE WHEN status = 'frozen'   THEN 1 ELSE 0 END), 0) AS frozen,
          COALESCE(SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END), 0) AS disabled,
          COALESCE(SUM(balance_cents), 0) AS total_balance_cents
        FROM customers`,
    );

    const transfers = one(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'pending') AS pending,
          COUNT(*) FILTER (WHERE status = 'approved') AS approved,
          COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
          COALESCE(SUM(amount_cents) FILTER (WHERE status = 'approved'), 0) AS settled_value_cents
        FROM transfers`,
    );

    const funding = one(
      `SELECT COALESCE(SUM(amount_cents), 0) AS funded_cents, COUNT(*) AS funding_count
         FROM ledger_entries WHERE entry_type = 'deposit'`,
    );

    const recentAudit = many('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 8');

    res.json({
      accounts: {
        total: accounts?.total ?? 0,
        active: accounts?.active ?? 0,
        locked: accounts?.locked ?? 0,
        frozen: accounts?.frozen ?? 0,
        disabled: accounts?.disabled ?? 0,
        totalBalanceCents: accounts?.total_balance_cents ?? 0,
        totalBalanceFormatted: formatCents(accounts?.total_balance_cents ?? 0),
      },
      transfers: {
        pending: transfers?.pending ?? 0,
        approved: transfers?.approved ?? 0,
        rejected: transfers?.rejected ?? 0,
        settledValueCents: transfers?.settled_value_cents ?? 0,
        settledValueFormatted: formatCents(transfers?.settled_value_cents ?? 0),
      },
      funding: {
        totalFundedCents: funding?.funded_cents ?? 0,
        totalFundedFormatted: formatCents(funding?.funded_cents ?? 0),
        count: funding?.funding_count ?? 0,
      },
      recentActivity: recentAudit.map(toAuditLog),
      rules: bankingRules(),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json({ settings: settingsSnapshot(), rules: bankingRules() });
  }),
);

/**
 * Update a banking rule. Restricted to superadmins, and every change is audited
 * with its previous value, since these settings govern money movement.
 */
const MUTABLE_SETTINGS = new Set([
  'require_transfer_approval',
  'transfer_fee_cents',
  'min_transfer_cents',
  'max_transfer_cents',
]);

const updateSettingSchema = z.object({
  key: z.string().trim().min(1, 'Choose a setting.'),
  value: z.union([z.string(), z.number(), z.boolean()]),
  reason: z.string().trim().max(240).optional(),
});

router.patch(
  '/settings',
  requireCsrf,
  requireRole('superadmin', 'admin'),
  validateBody(updateSettingSchema),
  asyncHandler(async (req, res) => {
    const { key, value, reason } = req.body;

    if (!MUTABLE_SETTINGS.has(key)) {
      throw validationFailed({ key: 'That setting cannot be changed here.' });
    }

    const before = settingsSnapshot()[key];
    setSetting(key, value);

    recordAudit({
      actorType: 'admin',
      actorId: req.auth.actor.id,
      actorEmail: req.auth.actor.email,
      action: AUDIT_ACTIONS.SETTING_UPDATED,
      targetType: 'setting',
      targetId: key,
      targetLabel: key,
      reason: reason ?? null,
      metadata: { before, after: String(value) },
      request: req,
    });

    res.json({ settings: settingsSnapshot(), rules: bankingRules(), message: 'Setting updated.' });
  }),
);

export default router;