/**
 * Audit logging.
 *
 * Every privileged or financially significant action is recorded here. The
 * table is append-only (enforced by triggers in schema.sql), so an attacker who
 * gains write access to the database still cannot erase the trail.
 */

import { one, run } from '../db/connection.js';
import { mirrorRow } from './firestore.js';

/** Canonical action names, so logs are searchable and typos impossible. */
export const AUDIT_ACTIONS = {
  ADMIN_LOGIN: 'admin.login',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  ADMIN_LOGOUT: 'admin.logout',
  CUSTOMER_LOGIN: 'customer.login',
  CUSTOMER_LOGIN_FAILED: 'customer.login_failed',
  CUSTOMER_LOGOUT: 'customer.logout',
  CUSTOMER_REGISTERED: 'customer.registered',
  CUSTOMER_PROFILE_UPDATED: 'customer.profile_updated',
  CUSTOMER_AVATAR_UPDATED: 'customer.avatar_updated',
  CUSTOMER_PASSWORD_CHANGED: 'customer.password_changed',
  CUSTOMER_PIN_CHANGED: 'customer.transfer_pin_changed',
  TRANSFER_REQUESTED: 'transfer.requested',
  TRANSFER_CANCELLED: 'transfer.cancelled',
  TRANSFER_APPROVED: 'transfer.approved',
  TRANSFER_REJECTED: 'transfer.rejected',
  ACCOUNT_FUNDED: 'account.funded',
  ACCOUNT_CREATED: 'account.created',
  ACCOUNT_UPDATED: 'account.updated',
  ACCOUNT_STATUS_CHANGED: 'account.status_changed',
  BALANCE_ADJUSTED: 'account.balance_adjusted',
  BANK_CREATED: 'bank.created',
  BANK_UPDATED: 'bank.updated',
  BANK_DELETED: 'bank.deactivated',
  SETTING_UPDATED: 'setting.updated',
  ADMIN_CREATED: 'admin.created',
  ADMIN_PASSWORD_ROTATED: 'admin.password_rotated',
  PASSWORD_RESET_REQUESTED: 'customer.password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'customer.password_reset_completed',
};

/**
 * Write one audit entry. Never throws: an audit failure must not roll back or
 * break the business operation the user actually asked for. Failures are
 * logged to stderr so they are still visible in monitoring.
 *
 * @param {object} entry
 * @param {'admin'|'customer'|'system'} entry.actorType
 * @param {number|null} entry.actorId
 * @param {string} entry.action       one of AUDIT_ACTIONS
 * @param {string} [entry.targetType] e.g. 'customer' | 'transfer' | 'bank'
 * @param {string|number} [entry.targetId]
 * @param {string} [entry.targetLabel] human-readable identifier
 * @param {string} [entry.reason]     required for destructive actions
 * @param {object} [entry.metadata]
 * @param {object} [entry.request]    Express request, for IP + user agent
 */
export function recordAudit(entry) {
  const {
    actorType = 'system',
    actorId = null,
    actorEmail = null,
    action,
    targetType = null,
    targetId = null,
    targetLabel = null,
    reason = null,
    metadata = null,
    request = null,
  } = entry;

  try {
    const inserted = run(
      `INSERT INTO audit_logs
         (actor_type, actor_id, actor_email, action, target_type, target_id,
          target_label, reason, metadata_json, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorType,
        actorId,
        actorEmail,
        action,
        targetType,
        targetId === null || targetId === undefined ? null : String(targetId),
        targetLabel,
        reason,
        metadata ? JSON.stringify(metadata) : null,
        request ? clientIp(request) : null,
        request ? truncate(request.get?.('user-agent'), 300) : null,
      ],
    );

    const row = one('SELECT * FROM audit_logs WHERE id = ?', [Number(inserted.lastInsertRowid)]);
    if (row) mirrorRow('audit_logs', row);
  } catch (error) {
    console.error('[audit] failed to record entry:', action, error.message);
  }
}

/** Best-effort client IP, honouring a single trusted proxy hop. */
export function clientIp(request) {
  const forwarded = request?.get?.('x-forwarded-for');
  if (forwarded) return truncate(forwarded.split(',')[0].trim(), 64);
  return truncate(request?.ip ?? request?.socket?.remoteAddress, 64);
}

function truncate(value, max) {
  if (!value) return null;
  return String(value).slice(0, max);
}

/** Read a single audit row by id. */
export function findAuditById(id) {
  return one('SELECT * FROM audit_logs WHERE id = ?', [id]);
}