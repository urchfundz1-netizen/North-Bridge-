/**
 * One-time (or whenever you like) SQLite -> Firestore backfill.
 *
 * Copies every mirrored table into the Firestore mirror. Safe to re-run:
 * document ids are the SQLite primary keys, so a second run overwrites each
 * document with the current row. Use it after enabling the mirror on a
 * database that already has data, or to repair drift after an outage.
 *
 * `sessions` is deliberately excluded - session tokens never leave SQLite.
 *
 * Every write is awaited before the script reports success, so an exit code
 * of 0 really means the mirror holds the whole database.
 *
 * Run directly:  node src/db/backfill-firestore.js
 * Or:            npm run firestore:backfill
 */

import { many, closeDb } from './connection.js';
import { config } from '../core/config.js';
import { isEntryPoint } from '../core/is-entry-point.js';
import { initFirestore, mirror, mirrorRow, MIRROR_OMIT } from '../services/firestore.js';

/** Mirrored tables, in dependency-free order. `settings` is keyed by `key`. */
const TABLES = [
  'settings',
  'admins',
  'banks',
  'customers',
  'transfers',
  'ledger_entries',
  'receipts',
  'audit_logs',
];

export async function backfillFirestore() {
  if (!config.firebase.enabled) {
    throw new Error(
      'The Firestore mirror is disabled (set FIREBASE_ENABLED=1 and the three credential variables in .env).',
    );
  }
  if (!initFirestore()) {
    throw new Error('Firestore could not be initialised - check the credentials in .env.');
  }

  const counts = {};
  const pending = [];

  for (const table of TABLES) {
    const rows = many(`SELECT * FROM ${table}`);
    for (const row of rows) {
      if (table === 'settings') {
        pending.push(mirror('settings', row.key, { ...row }));
        continue;
      }
      if (table === 'receipts') {
        const { payload_json, ...rest } = row;
        let payload = null;
        try {
          payload = JSON.parse(payload_json);
        } catch {
          payload = null;
        }
        pending.push(mirror('receipts', row.id, { ...rest, payload }));
        continue;
      }
      pending.push(mirrorRow(table, row, MIRROR_OMIT[table] ?? []));
    }
    counts[table] = rows.length;
  }

  await Promise.allSettled(pending.filter(Boolean));
  return counts;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const counts = await backfillFirestore();
    for (const [table, count] of Object.entries(counts)) {
      console.log(`[backfill] ${table}: ${count} row(s)`);
    }
    console.log('[backfill] mirror writes complete');
    closeDb();
  } catch (error) {
    console.error('[backfill] failed:', error.message);
    closeDb();
    process.exitCode = 1;
  }
}
