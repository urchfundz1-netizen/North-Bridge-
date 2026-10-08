/**
 * Idempotent schema migration runner.
 *
 * The schema uses `CREATE ... IF NOT EXISTS` throughout, so running it
 * repeatedly is safe and idempotent: as long as schema changes are additive,
 * `npm run migrate` is a no-op on an up-to-date database.
 *
 * Run directly:  node src/db/migrate.js
 */

import { applySchema, getDb, closeDb } from './connection.js';
import { seedSettings, seedBanks } from './seed-data.js';
import { isEntryPoint } from '../core/is-entry-point.js';

export function migrate({ silent = false } = {}) {
  const db = getDb();
  applySchema(db);
  seedSettings(db);
  const banksAdded = seedBanks(db);
  if (!silent) {
    console.log('[migrate] schema ready');
    console.log(`[migrate] ${banksAdded} new bank(s) added to the catalogue`);
  }
}

const invokedDirectly = isEntryPoint(import.meta.url);

if (invokedDirectly) {
  try {
    migrate();
    closeDb();
  } catch (error) {
    console.error('[migrate] failed:', error.message);
    process.exitCode = 1;
  }
}