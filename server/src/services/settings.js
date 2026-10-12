/**
 * Runtime settings.
 *
 * Values are seeded from the environment at bootstrap, but thereafter live in
 * Firestore so banking rules can change without a redeploy. They are loaded
 * into a per-instance cache at boot; reads stay synchronous so `bankingRules()`
 * keeps its existing (synchronous) call sites.
 *
 * Serverless trade-off: `setSetting` refreshes only the instance that handled
 * the write. Other warm instances keep the old values until they recycle. For
 * banking rules that change rarely this is acceptable; a shared cache (Redis)
 * would remove the window if it ever matters.
 */

import { db, C, nowIso } from '../db/firestore.js';

const cache = new Map();

const NUMERIC = new Set([
  'require_transfer_approval',
  'transfer_fee_cents',
  'min_transfer_cents',
  'max_transfer_cents',
]);

/** Load every setting into the cache. Call once at boot (and after writes). */
export async function loadSettings() {
  const snap = await db().collection(C.settings).get();
  cache.clear();
  snap.forEach((doc) => {
    const key = doc.id;
    const raw = doc.data().value;
    cache.set(key, NUMERIC.has(key) ? Number(raw) : raw);
  });
  return cache;
}

/** Get a single setting, falling back when the key is absent. */
export function getSetting(key, fallback = null) {
  if (cache.has(key)) return cache.get(key);
  return fallback;
}

/** Upsert a setting and refresh the local cache. */
export async function setSetting(key, value) {
  const updatedAt = nowIso();
  await db()
    .collection(C.settings)
    .doc(key)
    .set({ key, value: String(value), updated_at: updatedAt }, { merge: true });
  cache.set(key, NUMERIC.has(key) ? Number(value) : String(value));
}

/** Snapshot of every setting, for the admin settings screen. */
export function settingsSnapshot() {
  const result = {};
  for (const [key, value] of cache) result[key] = value;
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
