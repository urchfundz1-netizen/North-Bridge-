/**
 * Bank catalogue.
 *
 * The bank list is data, not code: an administrator adds or retires banks and
 * customers pick from the current catalogue when sending money. This is what
 * allows transfers to institutions Northbridge has no relationship with.
 */

import { one, many, run, nowIso } from '../db/connection.js';
import { conflict, notFound, validationFailed } from '../core/errors.js';
import { recordAudit, AUDIT_ACTIONS } from './audit.js';
import { mirrorRow } from './firestore.js';

const BOOLEAN_FLAG = (value) => (value ? 1 : 0);

/**
 * Banks available for selection.
 * @param {{ includeInactive?: boolean, transferType?: string, search?: string }} options
 */
export function listBanks({ includeInactive = false, transferType = null, search = null } = {}) {
  const clauses = [];
  const params = [];

  if (!includeInactive) clauses.push('is_active = 1');

  if (transferType && transferType !== 'all') {
    const column = {
      local: 'supports_local',
      international: 'supports_international',
      wire: 'supports_wire',
    }[transferType];
    if (!column) throw validationFailed({ transferType: 'Unknown transfer type.' });
    clauses.push(`${column} = 1`);
  }

  if (search) {
    clauses.push('(name LIKE ? OR country LIKE ? OR code LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return many(`SELECT * FROM banks ${where} ORDER BY name COLLATE NOCASE ASC`, params);
}

export function findBankById(id) {
  return one('SELECT * FROM banks WHERE id = ?', [id]);
}

export function createBank(input, admin, request) {
  const name = input.name.trim();
  const duplicate = one('SELECT id FROM banks WHERE name = ? COLLATE NOCASE', [name]);
  if (duplicate) throw conflict(`${name} is already in the bank catalogue.`);

  const inserted = run(
    `INSERT INTO banks
       (name, code, country, routing_number_length,
        supports_local, supports_international, supports_wire, is_active, created_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      input.code?.trim() || null,
      input.country?.trim() || 'United States',
      input.routingNumberLength ?? null,
      BOOLEAN_FLAG(input.supportsLocal ?? true),
      BOOLEAN_FLAG(input.supportsInternational ?? true),
      BOOLEAN_FLAG(input.supportsWire ?? true),
      BOOLEAN_FLAG(input.isActive ?? true),
      admin.id,
    ],
  );

  const id = Number(inserted.lastInsertRowid);
  recordAudit({
    actorType: 'admin',
    actorId: admin.id,
    actorEmail: admin.email,
    action: AUDIT_ACTIONS.BANK_CREATED,
    targetType: 'bank',
    targetId: id,
    targetLabel: name,
    metadata: { country: input.country, code: input.code ?? null },
    request,
  });

  const bank = findBankById(id);
  mirrorRow('banks', bank);
  return bank;
}

export function updateBank(id, input, admin, request) {
  const before = findBankById(id);
  if (!before) throw notFound('Bank not found.');

  const columns = {
    name: 'name',
    code: 'code',
    country: 'country',
    routingNumberLength: 'routing_number_length',
    supportsLocal: 'supports_local',
    supportsInternational: 'supports_international',
    supportsWire: 'supports_wire',
    isActive: 'is_active',
  };

  const assignments = [];
  const params = [];

  for (const [key, column] of Object.entries(columns)) {
    if (input[key] === undefined) continue;
    let value = input[key];
    if (typeof input[key] === 'boolean') value = BOOLEAN_FLAG(input[key]);
    if (typeof value === 'string') value = value.trim() || null;
    assignments.push(`${column} = ?`);
    params.push(value);
  }

  if (assignments.length === 0) return before;

  if (input.name !== undefined) {
    const clash = one('SELECT id FROM banks WHERE name = ? COLLATE NOCASE AND id <> ?', [
      input.name.trim(),
      id,
    ]);
    if (clash) throw conflict('Another bank already uses that name.');
  }

  assignments.push('updated_at = ?');
  params.push(nowIso(), id);

  try {
    run(`UPDATE banks SET ${assignments.join(', ')} WHERE id = ?`, params);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed: banks.name')) {
      throw conflict('Another bank already uses that name.');
    }
    throw error;
  }

  recordAudit({
    actorType: 'admin',
    actorId: admin.id,
    actorEmail: admin.email,
    action: AUDIT_ACTIONS.BANK_UPDATED,
    targetType: 'bank',
    targetId: id,
    targetLabel: input.name?.trim() ?? before.name,
    reason: input.reason ?? null,
    metadata: {
      changedFields: Object.entries(columns)
        .filter(([key]) => input[key] !== undefined)
        .map(([key]) => key),
    },
    request,
  });

  const updated = findBankById(id);
  mirrorRow('banks', updated);
  return updated;
}

/**
 * Retire a bank. This is a soft delete (`is_active = 0`) rather than a DELETE:
 * historical transfers and receipts reference it, and deleting the row would
 * break those references or silently strip context from settled records.
 */
export function deactivateBank(id, admin, reason, request) {
  const bank = findBankById(id);
  if (!bank) throw notFound('Bank not found.');
  if (!bank.is_active) throw conflict(`${bank.name} is already inactive.`);

  run('UPDATE banks SET is_active = 0, updated_at = ? WHERE id = ?', [nowIso(), id]);

  recordAudit({
    actorType: 'admin',
    actorId: admin.id,
    actorEmail: admin.email,
    action: AUDIT_ACTIONS.BANK_DELETED,
    targetType: 'bank',
    targetId: id,
    targetLabel: bank.name,
    reason: reason ?? null,
    request,
  });

  const retired = findBankById(id);
  mirrorRow('banks', retired);
  return retired;
}
