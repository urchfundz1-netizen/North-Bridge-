/**
 * Bank catalogue.
 *
 * The bank list is data, not code: an administrator adds or retires banks and
 * customers pick from the current catalogue when sending money. This is what
 * allows transfers to institutions Northbridge has no relationship with.
 */

import {
  C,
  nowIso,
  getById,
  coll,
  snapRows,
  transaction,
  txnGetById,
  readCounter,
  bumpCounter,
  checkUnique,
  claimUnique,
  releaseUnique,
  txnSet,
} from '../db/firestore.js';
import { conflict, notFound, validationFailed } from '../core/errors.js';
import { recordAudit, AUDIT_ACTIONS } from './audit.js';

/** Normalised key for the bank-name unique index. */
const nameKey = (name) => `bankName:${String(name).trim().toLowerCase()}`;

/**
 * Banks available for selection.
 * @param {{ includeInactive?: boolean, transferType?: string, search?: string }} options
 */
export async function listBanks({ includeInactive = false, transferType = null, search = null } = {}) {
  const snap = await coll(C.banks).get();
  let rows = snapRows(snap);

  if (!includeInactive) rows = rows.filter((bank) => bank.is_active);

  if (transferType && transferType !== 'all') {
    const column = {
      local: 'supports_local',
      international: 'supports_international',
      wire: 'supports_wire',
    }[transferType];
    if (!column) throw validationFailed({ transferType: 'Unknown transfer type.' });
    rows = rows.filter((bank) => bank[column]);
  }

  if (search) {
    const needle = String(search).toLowerCase();
    rows = rows.filter((bank) =>
      [bank.name, bank.country, bank.code].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)),
    );
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return rows;
}

export async function findBankById(id) {
  return getById(C.banks, id);
}

export async function createBank(input, admin, request) {
  const name = input.name.trim();
  const now = nowIso();

  const id = await transaction(async (txn) => {
    const bankId = await readCounter(txn, C.banks);
    await checkUnique(txn, nameKey(name), bankId);

    bumpCounter(txn, C.banks, bankId);
    claimUnique(txn, nameKey(name), bankId);
    txnSet(txn, C.banks, bankId, {
      name,
      code: input.code?.trim() || null,
      country: input.country?.trim() || 'United States',
      routing_number_length: input.routingNumberLength ?? null,
      supports_local: input.supportsLocal ?? true,
      supports_international: input.supportsInternational ?? true,
      supports_wire: input.supportsWire ?? true,
      is_active: input.isActive ?? true,
      created_by_admin_id: admin.id,
      created_at: now,
      updated_at: now,
    });
    return bankId;
  }).catch((error) => {
    if (error.code === 'unique_violation') {
      throw conflict(`${name} is already in the bank catalogue.`);
    }
    throw error;
  });

  await recordAudit({
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

  return findBankById(id);
}

export async function updateBank(id, input, admin, request) {
  const before = await findBankById(id);
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

  const patch = {};
  for (const [key, column] of Object.entries(columns)) {
    if (input[key] === undefined) continue;
    let value = input[key];
    if (typeof value === 'string') value = value.trim() || null;
    patch[column] = value;
  }

  if (Object.keys(patch).length === 0) return before;

  const renamed = patch.name !== undefined && patch.name !== before.name;
  patch.updated_at = nowIso();

  await transaction(async (txn) => {
    const current = await txnGetById(txn, C.banks, id);
    if (!current) throw notFound('Bank not found.');

    if (renamed) {
      await checkUnique(txn, nameKey(patch.name), id);
      releaseUnique(txn, nameKey(before.name));
      claimUnique(txn, nameKey(patch.name), id);
    }

    txnSet(txn, C.banks, id, patch, { merge: true });
  }).catch((error) => {
    if (error.code === 'unique_violation') {
      throw conflict('Another bank already uses that name.');
    }
    throw error;
  });

  await recordAudit({
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

  return findBankById(id);
}

/**
 * Retire a bank. Soft delete (`is_active = false`): historical transfers and
 * receipts reference it, and removing the row would strip context from settled
 * records.
 */
export async function deactivateBank(id, admin, reason, request) {
  const bank = await findBankById(id);
  if (!bank) throw notFound('Bank not found.');
  if (!bank.is_active) throw conflict(`${bank.name} is already inactive.`);

  await coll(C.banks).doc(String(id)).set({ is_active: false, updated_at: nowIso() }, { merge: true });

  await recordAudit({
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

  return findBankById(id);
}
