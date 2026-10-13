/**
 * One-time SQLite -> Firestore data migration.
 *
 * The codebase moved from a local SQLite database to Firestore as its source
 * of truth. This script copies the existing rows into the documents the
 * services now read, preserving the numeric ids SQLite assigned, then bumps
 * every id counter and claims every uniqueness guard so migrated rows stay
 * consistent with future writes.
 *
 * Idempotent and safe to re-run: document ids are the SQLite primary keys, so
 * a second run overwrites documents in place and re-asserts counters/refs.
 * The SQLite file is left untouched, so it remains a rollback source.
 *
 * Collection mapping (same snake_case fields the services use):
 *   settings/.doc(key), and one .doc(id) per row for admins, banks,
 *   customers, transfers, ledger_entries, receipts and audit_logs.
 *   sessions/.doc(token_hash) with actor_id stringified.
 * Plus counters/<collection> { value } and unique_refs/<key> { ownerId }.
 *
 * Credentials: uses the Firestore emulator when FIRESTORE_EMULATOR_HOST is
 * set (a safe dry-run), otherwise the FIREBASE_CLIENT_EMAIL /
 * FIREBASE_PRIVATE_KEY pair in .env, else Application Default Credentials.
 *
 * Real-project writes require --yes so a typo cannot wipe/silently mutate the
 * live database.
 */

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { SERVER_ROOT } from '../core/config.js';
import { isEntryPoint } from '../core/is-entry-point.js';
import { initFirestore as initSharedFirestore, db } from './firestore.js';

/** Same collection names the services use (C from ./firestore.js). */
const AUTO_ID_COLLECTIONS = [
  'admins',
  'banks',
  'customers',
  'transfers',
  'ledger_entries',
  'receipts',
  'audit_logs',
];

function loadEnvPrivateKey() {
  return process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').trim();
}

/**
 * Create the Firebase app with the right credentials, then reuse the shared
 * `db/firestore.js` handle so the whole process talks to one Firestore
 * instance (its `settings()` may only run once).
 */
function initFirestore() {
  const emulating = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'demo-northbridge';

  if (!getApps().length) {
    if (emulating) {
      initializeApp({ projectId });
    } else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      initializeApp({
        credential: cert({
          projectId,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: loadEnvPrivateKey(),
        }),
        projectId,
      });
    } else {
      initializeApp({ credential: applicationDefault(), projectId });
    }
  }

  initSharedFirestore();
  console.log(`  Target: ${projectId} (${emulating ? 'EMULATOR' : 'real project'})`);
  return db();
}

/** Copy a SQLite row, dropping keys Firestore cannot store. */
function cleanRow(row, omitKeys = []) {
  const copy = { ...row };
  for (const key of omitKeys) delete copy[key];
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) delete copy[key];
  }
  return copy;
}

/** Firestore reference for a uniqueness guard, matching db/firestore.js:uniqueRef. */
function uniqueRef(firestore, key) {
  return firestore.collection('unique_refs').doc(String(key).replace(/\//g, '%2F'));
}

export async function migrateLegacyData({ dbFile, yes = false, silent = false } = {}) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const read = (table) => db.prepare(`SELECT * FROM "${table}"`).all();

  const firestore = initFirestore();

  const log = silent ? () => {} : (...args) => console.log(...args);

  /* ------------------------------------------------------------------ */
  /* Read phase                                                          */
  /* ------------------------------------------------------------------ */

  const tables = {};
  for (const table of AUTO_ID_COLLECTIONS) tables[table] = read(table);
  tables.settings = read('settings');
  tables.sessions = read('sessions');

  /* ------------------------------------------------------------------ */
  /* Build the document writes                                           */
  /* ------------------------------------------------------------------ */

  const writes = [];

  for (const row of tables.settings) {
    writes.push({ ref: firestore.collection('settings').doc(String(row.key)), data: cleanRow(row) });
  }

  for (const table of AUTO_ID_COLLECTIONS) {
    for (const row of tables[table]) {
      let data = cleanRow(row);
      if (table === 'receipts' && row.payload_json !== undefined) {
        data = { ...cleanRow(row, ['payload_json']), payload: parsePayload(row.payload_json) };
      }
      writes.push({ ref: firestore.collection(table).doc(String(row.id)), data });
    }
  }

  // Sessions are keyed by token hash and their actor_id is stored stringified
  // (see core/session.js, whose lookups query actor_id == String(actorId)).
  for (const row of tables.sessions) {
    const data = cleanRow(row, ['id']);
    data.actor_id = String(row.actor_id);
    writes.push({ ref: firestore.collection('sessions').doc(String(row.token_hash)), data });
  }

  /* -- Counters: the next allocated id must exceed every migrated id. -- */
  const counters = [];
  for (const table of AUTO_ID_COLLECTIONS) {
    const ids = tables[table].map((row) => Number(row.id));
    if (!ids.length) continue;
    counters.push({ table, value: Math.max(...ids) });
    writes.push({
      ref: firestore.collection('counters').doc(table),
      data: { value: Math.max(...ids) },
    });
  }

  /* -- Uniqueness guards, claiming the migrated values for their owners. -- */
  const guards = [];
  for (const c of tables.customers) {
    guards.push({ key: `customerEmail:${String(c.email).trim().toLowerCase()}`, ownerId: c.id });
    guards.push({ key: `customerAccount:${c.account_number}`, ownerId: c.id });
  }
  for (const b of tables.banks) {
    guards.push({ key: `bankName:${String(b.name).trim().toLowerCase()}`, ownerId: b.id });
  }
  for (const t of tables.transfers) {
    guards.push({ key: `transferRef:${t.reference_number}`, ownerId: t.id });
    if (t.idempotency_key) guards.push({ key: `transferIdem:${t.customer_id}:${t.idempotency_key}`, ownerId: t.id });
  }
  for (const r of tables.receipts) {
    guards.push({ key: `receiptTransfer:${r.transfer_id}`, ownerId: r.id });
    guards.push({ key: `receiptNumber:${r.receipt_number}`, ownerId: r.id });
  }
  for (const l of tables.ledger_entries) {
    if (l.transfer_id != null) {
      guards.push({ key: `ledger:${l.transfer_id}:${l.entry_type}`, ownerId: l.id });
    }
  }
  for (const g of guards) {
    writes.push({ ref: uniqueRef(firestore, g.key), data: { key: g.key, ownerId: String(g.ownerId) } });
  }

  /* ------------------------------------------------------------------ */
  /* Plan + confirm                                                      */
  /* ------------------------------------------------------------------ */

  const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  log('\nMigration plan:');
  for (const table of ['settings', ...AUTO_ID_COLLECTIONS, 'sessions']) {
    log(`  ${table.padEnd(16)} ${tables[table].length} document(s)`);
  }
  log(`  counters${''.padEnd(10)} ${counters.length} counter(s)`);
  log(`  unique_refs${''.padEnd(7)} ${guards.length} guard(s)`);

  if (!isEmulator && !yes) {
    console.error('\nRefusing to write to a real project without confirmation.');
    console.error('Dry-run against the emulator first, then re-run with --yes for the real project.');
    db.close();
    process.exitCode = 1;
    return { dryRun: true };
  }

  /* ------------------------------------------------------------------ */
  /* Write phase (batched)                                               */
  /* ------------------------------------------------------------------ */

  const BATCH = 450;
  for (let i = 0; i < writes.length; i += BATCH) {
    const batch = firestore.batch();
    for (const { ref, data } of writes.slice(i, i + BATCH)) batch.set(ref, data);
    await batch.commit();
  }
  log(`\nWrote ${writes.length} document(s) in ${Math.ceil(writes.length / BATCH)} batch(es).`);

  /* ------------------------------------------------------------------ */
  /* Verify: compare Firestore counts against the SQLite rows.           */
  /* ------------------------------------------------------------------ */

  const expected = new Map([
    ['settings', tables.settings.length],
    ['sessions', tables.sessions.length],
    ['unique_refs', guards.length],
    ['counters', counters.length],
  ]);
  for (const table of AUTO_ID_COLLECTIONS) expected.set(table, tables[table].length);

  let mismatches = 0;
  for (const [collection, count] of expected) {
    const actual = await firestore.collection(collection).count().get();
    const n = actual.data().count;
    if (n !== count) {
      mismatches += 1;
      log(`  ${collection}: expected ${count}, found ${n}  <-- MISMATCH`);
    } else {
      log(`  ${collection}: ${n} OK`);
    }
  }

  db.close();
  if (mismatches) {
    console.error(`\nVerification failed with ${mismatches} mismatch(es).`);
    process.exitCode = 1;
    return { ok: false };
  }

  log('\nMigration complete and verified.');
  return { ok: true, written: writes.length };
}

function parsePayload(json) {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

if (isEntryPoint(import.meta.url)) {
  const dbFile = resolve(
    SERVER_ROOT,
    process.env.DATABASE_FILE ? process.env.DATABASE_FILE : './data/northbridge.db',
  );
  console.log(`Database: ${dbFile}`);
  try {
    await migrateLegacyData({ dbFile, yes: process.argv.includes('--yes') });
  } catch (error) {
    console.error('[migrate:data] failed:', error.message);
    process.exitCode = 1;
  }
}