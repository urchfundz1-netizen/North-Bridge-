/**
 * Idempotent bootstrap. Firestore has no schema DDL: the "migration" is just
 * making sure the settings and starter banks exist. Safe to run repeatedly.
 *
 * Run directly:  node src/db/migrate.js
 */

import { initFirestore } from './firestore.js';
import { seedSettings, seedBanks } from './seed-data.js';
import { isEntryPoint } from '../core/is-entry-point.js';

export async function bootstrap({ silent = false } = {}) {
  initFirestore();
  await seedSettings();
  const banksAdded = await seedBanks();
  if (!silent) {
    console.log('[migrate] reference data ready');
    console.log(`[migrate] ${banksAdded} new bank(s) added to the catalogue`);
  }
  return { banksAdded };
}

/** Backwards-compatible name for older call sites. */
export const migrate = bootstrap;

const invokedDirectly = isEntryPoint(import.meta.url);

if (invokedDirectly) {
  bootstrap()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[migrate] failed:', error.message);
      process.exit(1);
    });
}
