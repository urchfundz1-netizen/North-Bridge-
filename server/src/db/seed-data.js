/**
 * Reference data written at bootstrap: default settings and the initial
 * catalogue of supported banks.
 *
 * Existing rows are never overwritten, so administrator edits (renamed banks,
 * deactivated institutions) survive re-running bootstrap.
 */

import { config } from '../core/config.js';
import { db, C, nowIso, nextId, transaction } from './firestore.js';

export const DEFAULT_SETTINGS = {
  require_transfer_approval: config.banking.requireTransferApproval ? '1' : '0',
  transfer_fee_cents: String(config.banking.transferFeeCents),
  min_transfer_cents: String(config.banking.minTransferCents),
  max_transfer_cents: String(config.banking.maxTransferCents),
  bank_name: 'Northbridge Bank',
  support_email: 'support@northbridge.bank',
  support_phone: '+1 (800) 555-0142',
};

export const STARTER_BANKS = [
  { name: 'Northbridge Bank', code: 'NBBK', country: 'United States', routing: 9, local: 1, intl: 1, wire: 1 },
  { name: 'Meridian Trust Bank', code: 'MRDT', country: 'United States', routing: 9, local: 1, intl: 1, wire: 1 },
  { name: 'Atlas Federal Savings', code: 'ATLS', country: 'United States', routing: 9, local: 1, intl: 1, wire: 1 },
  { name: 'Harborview Credit Union', code: 'HVCU', country: 'United States', routing: 9, local: 1, intl: 0, wire: 0 },
  { name: 'Sterling National Bank', code: 'STLN', country: 'United States', routing: 9, local: 1, intl: 1, wire: 1 },
  { name: 'Continental Commercial Bank', code: 'CCBK', country: 'United States', routing: 9, local: 1, intl: 1, wire: 1 },
  { name: 'Unity Cooperative Bank', code: 'UNCP', country: 'Canada', routing: 0, local: 0, intl: 1, wire: 1 },
  { name: 'Pinnacle Union Bank', code: 'PNUB', country: 'United Kingdom', routing: 6, local: 0, intl: 1, wire: 1 },
  { name: 'Deutsche Handelsbank', code: 'DHBK', country: 'Germany', routing: 8, local: 0, intl: 1, wire: 1 },
  { name: 'Shinsei Commercial Bank', code: 'SHNS', country: 'Japan', routing: 4, local: 0, intl: 1, wire: 1 },
  { name: 'Aurora Pacific Bank', code: 'AUPB', country: 'Australia', routing: 6, local: 0, intl: 1, wire: 1 },
  { name: 'Sahara Trade Finance Bank', code: 'SHTF', country: 'United Arab Emirates', routing: 3, local: 0, intl: 1, wire: 1 },
];

/** Insert any missing setting keys. Existing values always win. */
export async function seedSettings() {
  const existing = await db().collection(C.settings).get();
  const present = new Set(existing.docs.map((d) => d.id));
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (present.has(key)) continue;
    await db().collection(C.settings).doc(key).set({ key, value, updated_at: nowIso() });
  }
}

/**
 * Insert any missing starter banks. Uniqueness is enforced by the same
 * `bankName:<lowercase>` index document the bank service uses, so seeding and
 * admin-created banks cannot collide.
 */
export async function seedBanks() {
  let added = 0;
  for (const bank of STARTER_BANKS) {
    const created = await transaction(async (txn) => {
      const key = `bankName:${bank.name.toLowerCase()}`;
      const idx = await txn.get(db().collection(C.refs).doc(key));
      if (idx.exists) return false;

      const id = await nextId(txn, C.banks);
      const now = nowIso();
      txn.set(db().collection(C.banks).doc(String(id)), {
        id,
        name: bank.name,
        name_normalized: bank.name.toLowerCase(),
        code: bank.code,
        country: bank.country,
        routing_number_length: bank.routing || null,
        supports_local: bank.local,
        supports_international: bank.intl,
        supports_wire: bank.wire,
        is_active: 1,
        created_by_admin_id: null,
        created_at: now,
        updated_at: now,
      });
      txn.set(db().collection(C.refs).doc(key), { key, ownerId: String(id) });
      return true;
    });
    if (created) added += 1;
  }
  return added;
}
