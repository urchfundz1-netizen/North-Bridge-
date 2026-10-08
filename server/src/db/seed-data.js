/**
 * Reference data written by the migration: default settings and the initial
 * catalogue of supported banks.
 *
 * Existing rows are never overwritten, so administrator edits (renamed banks,
 * deactivated institutions) survive re-running the migration.
 */

import { config } from '../core/config.js';

export const DEFAULT_SETTINGS = {
  require_transfer_approval: config.banking.requireTransferApproval ? '1' : '0',
  transfer_fee_cents: String(config.banking.transferFeeCents),
  min_transfer_cents: String(config.banking.minTransferCents),
  max_transfer_cents: String(config.banking.maxTransferCents),
  bank_name: 'Northbridge Bank',
  support_email: 'support@northbridge.bank',
  support_phone: '+1 (800) 555-0142',
};

/** Insert any missing setting keys. Existing values always win. */
export function seedSettings(db) {
  const insert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO NOTHING`,
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(key, value);
  }
}

const STARTER_BANKS = [
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

/** Insert any missing starter banks (matched case-insensitively by name). */
export function seedBanks(db) {
  const exists = db.prepare('SELECT id FROM banks WHERE name = ? COLLATE NOCASE');
  const insert = db.prepare(
    `INSERT INTO banks
       (name, code, country, routing_number_length, supports_local, supports_international, supports_wire)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  for (const bank of STARTER_BANKS) {
    if (exists.get(bank.name)) continue;
    insert.run(
      bank.name,
      bank.code,
      bank.country,
      bank.routing || null,
      bank.local,
      bank.intl,
      bank.wire,
    );
    added += 1;
  }
  return added;
}