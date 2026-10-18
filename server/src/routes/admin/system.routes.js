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
import { coll, C, snapRows, countOf, sumOf, FieldPath } from '../../db/firestore.js';
import { recordAudit, AUDIT_ACTIONS } from '../../services/audit.js';
import { settingsSnapshot, bankingRules, setSetting } from '../../services/settings.js';
import { formatCents } from '../../core/money.js';
import { validationFailed } from '../../core/errors.js';

const router = Router();

router.use(attachAuth('admin'), requireAdmin);

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

/** Newest first; numeric id breaks ties. */
function sortAuditRows(rows) {
  return rows.sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });
}

/** Paginated, filterable audit trail. */
router.get(
  '/audit-logs',
  validateQuery(auditListSchema),
  asyncHandler(async (req, res) => {
    const { limit, offset, action, actorType, actorId, targetType, search } = req.validatedQuery;

    // Equality filters run server-side so only matching documents are read;
    // sorting and paging then happen over that narrowed set. Firestore serves
    // multiple equality filters from single-field indexes - no composite
    // index is required, and never combine where() with orderBy() here.
    const filters = [];
    if (action) filters.push(['action', action]);
    if (actorType && actorType !== 'all') filters.push(['actor_type', actorType]);
    if (actorId) filters.push(['actor_id', actorId]);
    if (targetType) filters.push(['target_type', targetType]);

    const base = filters.reduce((query, [field, value]) => query.where(field, '==', value), coll(C.audit));

    let page;
    let total;

    if (search || filters.length) {
      // Substring search has no server-side equivalent, so it still scans -
      // but only the (usually already narrowed) match set, never the whole
      // collection when filters are present.
      let rows = snapRows(await base.get());
      if (search) {
        const needle = String(search).toLowerCase();
        rows = rows.filter((r) =>
          [r.action, r.actor_email, r.target_label, r.reason, r.target_id]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(needle)),
        );
      }
      sortAuditRows(rows);
      total = rows.length;
      page = rows.slice(offset, offset + limit);
    } else {
      // Default view: read only the newest offset+limit documents instead of
      // the entire audit history, and get the page total from a count
      // aggregation (one read, independent of collection size).
      const window = snapRows(
        await coll(C.audit)
          .orderBy('created_at', 'desc')
          .orderBy(FieldPath.documentId(), 'desc')
          .limit(offset + limit)
          .get(),
      );
      sortAuditRows(window);
      total = await countOf(coll(C.audit));
      page = window.slice(offset, offset + limit);
    }

    res.json(paginated(page.map(toAuditLog), total, { limit, offset }));
  }),
);

/**
 * Distinct action names, for populating the filter dropdown.
 *
 * The action vocabulary is effectively static (AUDIT_ACTIONS plus a few
 * one-off literals), but discovering it means scanning the collection, so the
 * result is cached briefly rather than re-scanned on every page visit.
 */
let actionListCache = { at: 0, actions: null };
const ACTION_CACHE_TTL_MS = 5 * 60_000;

router.get(
  '/audit-logs/actions',
  asyncHandler(async (_req, res) => {
    if (!actionListCache.actions || Date.now() - actionListCache.at > ACTION_CACHE_TTL_MS) {
      const rows = snapRows(await coll(C.audit).get());
      actionListCache = {
        at: Date.now(),
        actions: [...new Set(rows.map((r) => r.action).filter(Boolean))].sort(),
      };
    }
    res.json({ actions: actionListCache.actions });
  }),
);

/* -------------------------------------------------------------------------- */
/* System overview                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Headline numbers for the admin dashboard.
 *
 * Every figure is a count() or sum() aggregation - one billed read each,
 * independent of collection size - plus an 8-document window for recent
 * activity. The previous implementation fetched every customer, transfer,
 * ledger entry and audit row (four full scans, thousands of reads per page
 * load), which is what emptied the free daily quota.
 */
router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const customers = coll(C.customers);
    const transfers = coll(C.transfers);
    const ledger = coll(C.ledger);

    const [
      customerTotal,
      activeCount,
      lockedCount,
      frozenCount,
      disabledCount,
      balanceAgg,
      pendingCount,
      approvedCount,
      rejectedCount,
      settledAgg,
      fundingCount,
      fundingAgg,
      recentAudit,
    ] = await Promise.all([
      countOf(customers),
      countOf(customers.where('status', '==', 'active')),
      countOf(customers.where('status', '==', 'locked')),
      countOf(customers.where('status', '==', 'frozen')),
      countOf(customers.where('status', '==', 'disabled')),
      sumOf(customers, 'balance_cents'),
      countOf(transfers.where('status', '==', 'pending')),
      countOf(transfers.where('status', '==', 'approved')),
      countOf(transfers.where('status', '==', 'rejected')),
      sumOf(transfers.where('status', '==', 'approved'), 'amount_cents'),
      countOf(ledger.where('entry_type', '==', 'deposit')),
      sumOf(ledger.where('entry_type', '==', 'deposit'), 'amount_cents'),
      coll(C.audit)
        .orderBy('created_at', 'desc')
        .orderBy(FieldPath.documentId(), 'desc')
        .limit(8)
        .get(),
    ]);

    res.json({
      accounts: {
        total: customerTotal,
        active: activeCount,
        locked: lockedCount,
        frozen: frozenCount,
        disabled: disabledCount,
        totalBalanceCents: balanceAgg,
        totalBalanceFormatted: formatCents(balanceAgg),
      },
      transfers: {
        pending: pendingCount,
        approved: approvedCount,
        rejected: rejectedCount,
        settledValueCents: settledAgg,
        settledValueFormatted: formatCents(settledAgg),
      },
      funding: {
        totalFundedCents: fundingAgg,
        totalFundedFormatted: formatCents(fundingAgg),
        count: fundingCount,
      },
      recentActivity: sortAuditRows(snapRows(recentAudit)).map(toAuditLog),
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