/**
 * Runtime settings.
 *
 * Values are seeded from the environment by the migration, but thereafter live
 * in the database so banking rules can be changed without a redeploy. Cached in
 * memory and refreshed on write.
 */

import { one, run, many, nowIso } from '../db/connection.js';
import { mirror } from './firestore.js';

const cache = new Map();

const NUMERIC = new Set([
  'require_transfer_approval',
  'transfer_fee_cents',
  'min_transfer_cents',
  'max_transfer_cents',
]);

/** Get a single setting, falling back when the key is absent. */
export function getSetting(key, fallback = null) {
  if (cache.has(key)) return cache.get(key);
  const row = one('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return fallback;
  const value = NUMERIC.has(key) ? Number(row.value) : row.value;
  cache.set(key, value);
  return value;
}

/** Upsert a setting and refresh the cache. */
export function setSetting(key, value) {
  const updatedAt = nowIso();
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(value), updatedAt],
  );
  cache.set(key, NUMERIC.has(key) ? Number(value) : String(value));
  mirror('settings', key, { key, value: String(value), updated_at: updatedAt });
}

/** Snapshot of every setting, for the admin settings screen. */
export function settingsSnapshot() {
  const result = {};
  for (const row of many('SELECT key, value FROM settings ORDER BY key')) {
    result[row.key] = NUMERIC.has(row.key) ? Number(row.value) : row.value;
  }
  return result;
}

export function clearSettingsCache() {
  cache.clear();
}

/** The banking rules that actually govern a transfer. */
export function bankingRules() {
  return {
    requireApproval: Boolean(getSetting('require_transfer_approval', 1)),
    transferFeeCents: Number(getSetting('transfer_fee_cents', 150)),
    minTransferCents: Number(getSetting('min_transfer_cents', 100)),
    maxTransferCents: Number(getSetting('max_transfer_cents', 50_000_000)),
    bankName: getSetting('bank_name', 'Northbridge Bank'),
    supportEmail: getSetting('support_email', 'support@northbridge.bank'),
    supportPhone: getSetting('support_phone', '+1 (800) 555-0142'),
  };
}