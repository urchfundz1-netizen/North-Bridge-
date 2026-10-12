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
import { coll, C, snapRows } from '../../db/firestore.js';
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

    let rows = snapRows(await coll(C.audit).get());

    if (action) {
      rows = rows.filter((r) => r.action === action);
    }
    if (actorType && actorType !== 'all') {
      rows = rows.filter((r) => r.actor_type === actorType);
    }
    if (actorId) {
      rows = rows.filter((r) => String(r.actor_id) === String(actorId));
    }
    if (targetType) {
      rows = rows.filter((r) => r.target_type === targetType);
    }
    if (search) {
      const needle = String(search).toLowerCase();
      rows = rows.filter((r) =>
        [
          r.action,
          r.actor_email,
          r.target_label,
          r.reason,
          r.target_id,
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
      );
    }

    rows.sort((a, b) => {
      if (a.created_at === b.created_at) return b.id - a.id;
      return a.created_at < b.created_at ? 1 : -1;
    });

    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    res.json(paginated(page.map(toAuditLog), total, { limit, offset }));
  }),
);

/** Distinct action names, for populating the filter dropdown. */
router.get(
  '/audit-logs/actions',
  asyncHandler(async (_req, res) => {
    const rows = snapRows(await coll(C.audit).get());
    const actions = [...new Set(rows.map((r) => r.action).filter(Boolean))].sort();
    res.json({ actions });
  }),
);

/* -------------------------------------------------------------------------- */
/* System overview                                                            */
/* -------------------------------------------------------------------------- */

/** Headline numbers for the admin dashboard. */
router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const customers = snapRows(await coll(C.customers).get());
    const transfers = snapRows(await coll(C.transfers).get());
    const ledger = snapRows(await coll(C.ledger).get());

    const accounts = customers.reduce(
      (acc, c) => {
        acc.total += 1;
        if (c.status === 'active') acc.active += 1;
        if (c.status === 'locked') acc.locked += 1;
        if (c.status === 'frozen') acc.frozen += 1;
        if (c.status === 'disabled') acc.disabled += 1;
        acc.total_balance_cents += Number(c.balance_cents || 0);
        return acc;
      },
      { total: 0, active: 0, locked: 0, frozen: 0, disabled: 0, total_balance_cents: 0 },
    );

    const transferAgg = transfers.reduce(
      (acc, t) => {
        if (t.status === 'pending') acc.pending += 1;
        if (t.status === 'approved') acc.approved += 1;
        if (t.status === 'rejected') acc.rejected += 1;
        if (t.status === 'approved') acc.settled_value_cents += Number(t.amount_cents || 0);
        return acc;
      },
      { pending: 0, approved: 0, rejected: 0, settled_value_cents: 0 },
    );

    const fundingAgg = ledger.reduce(
      (acc, e) => {
        if (e.entry_type === 'deposit') {
          acc.funded_cents += Number(e.amount_cents || 0);
          acc.funding_count += 1;
        }
        return acc;
      },
      { funded_cents: 0, funding_count: 0 },
    );

    const recentAudit = snapRows(await coll(C.audit).get())
      .sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1))
      .slice(0, 8);

    res.json({
      accounts: {
        total: accounts.total,
        active: accounts.active,
        locked: accounts.locked,
        frozen: accounts.frozen,
        disabled: accounts.disabled,
        totalBalanceCents: accounts.total_balance_cents,
        totalBalanceFormatted: formatCents(accounts.total_balance_cents),
      },
      transfers: {
        pending: transferAgg.pending,
        approved: transferAgg.approved,
        rejected: transferAgg.rejected,
        settledValueCents: transferAgg.settled_value_cents,
        settledValueFormatted: formatCents(transferAgg.settled_value_cents),
      },
      funding: {
        totalFundedCents: fundingAgg.funded_cents,
        totalFundedFormatted: formatCents(fundingAgg.funded_cents),
        count: fundingAgg.funding_count,
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
    await setSetting(key, value);

    await recordAudit({
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