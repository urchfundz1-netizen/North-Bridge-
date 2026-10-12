/**
 * Seed the reference data every installation needs: settings and the bank
 * catalogue.
 */

import { initFirestore } from './firestore.js';
import { migrate } from './migrate.js';
import { seedSettings, seedBanks } from './seed-data.js';
import { isEntryPoint } from '../core/is-entry-point.js';
import { reportFailure } from './report-failure.js';
import { coll, C, snapRows } from './firestore.js';

export async function seedReferenceData() {
  initFirestore();

  const settingsBefore = snapRows(await coll(C.settings).get()).length;
  await seedSettings();
  const settingsAfter = snapRows(await coll(C.settings).get()).length;

  const banksAdded = await seedBanks();
  const banksTotal = snapRows(await coll(C.banks).get()).length;

  return {
    settingsAdded: settingsAfter - settingsBefore,
    settingsTotal: settingsAfter,
    banksAdded,
    banksTotal,
  };
}

if (isEntryPoint(import.meta.url)) {
  try {
    await migrate({ silent: true });
    const result = await seedReferenceData();

    console.log('[seed] reference data ready');
    console.log(`  settings: ${result.settingsTotal} total (${result.settingsAdded} added)`);
    console.log(`  banks:    ${result.banksTotal} total (${result.banksAdded} added)`);
  } catch (error) {
    reportFailure('seed', error);
    process.exitCode = 1;
  }
}
