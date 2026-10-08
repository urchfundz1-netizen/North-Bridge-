/**
 * Seed the reference data every installation needs: settings and the bank
 * catalogue.
 *
 * Safe to run repeatedly. Both writers insert only what is missing and never
 * overwrite an existing row, so administrator edits survive. Running the
 * migration already does this implicitly; this script exists so an operator can
 * top up the catalogue later without a full migration.
 *
 *   npm run seed
 */

import { getDb, closeDb, one } from './connection.js';
import { migrate } from './migrate.js';
import { seedSettings, seedBanks } from './seed-data.js';
import { isEntryPoint } from '../core/is-entry-point.js';
import { reportFailure } from './report-failure.js';

export function seedReferenceData() {
  const db = getDb();

  const settingsBefore = one('SELECT COUNT(*) AS total FROM settings').total;
  seedSettings(db);
  const settingsAfter = one('SELECT COUNT(*) AS total FROM settings').total;

  const banksAdded = seedBanks(db);
  const banksTotal = one('SELECT COUNT(*) AS total FROM banks').total;

  return {
    settingsAdded: settingsAfter - settingsBefore,
    settingsTotal: settingsAfter,
    banksAdded,
    banksTotal,
  };
}

if (isEntryPoint(import.meta.url)) {
  try {
    migrate({ silent: true });
    const result = seedReferenceData();

    console.log('[seed] reference data ready');
    console.log(`  settings: ${result.settingsTotal} total (${result.settingsAdded} added)`);
    console.log(`  banks:    ${result.banksTotal} total (${result.banksAdded} added)`);
    closeDb();
  } catch (error) {
    reportFailure('seed', error);
    process.exitCode = 1;
  }
}
