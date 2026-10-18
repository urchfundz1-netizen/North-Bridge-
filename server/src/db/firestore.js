/**
 * Firestore access layer (replaces db/connection.js).
 *
 * SQLite gave us three things Firestore does not: SQL constraints, triggers,
 * and synchronous transactions. This module rebuilds the primitives the rest of
 * the server needs so the services port without every call site inventing its
 * own convention:
 *
 *   * `transaction(fn)`  - async ACID transaction (like BEGIN IMMEDIATE).
 *   * `readCounter()` /  - auto-increment integer ids from a counter document,
 *     `bumpCounter()`     so the numeric ids survive the migration.
 *   * `checkUnique()` /  - a stand-in for UNIQUE constraints: one index
 *     `claimUnique()`     document per unique value, checked and claimed in the
 *                         same transaction as the row it protects.
 *
 * Firestore transactions may not read after they write (the SDK enforces
 * `READ_AFTER_WRITE_ERROR_MSG`). The primitives are therefore split into
 * read helpers and write helpers and callers perform all reads first, then all
 * writes. Read helpers are `txnGetById`, `readCounter`, `checkUnique`; write
 * helpers are `txnSet`, `txnDelete`, `bumpCounter`, `claimUnique`,
 * `releaseUnique`.
 *
 * Documents use the same snake_case field names the old SQLite tables used, so
 * the existing serializers and receipts keep working unchanged. Numeric ids
 * are the same keys SQLite assigned (stringified as Firestore requires).
 */

import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, AggregateField, FieldPath } from 'firebase-admin/firestore';
import { config } from '../core/config.js';

/* -------------------------------------------------------------------------- */
/* Init                                                                        */
/* -------------------------------------------------------------------------- */

let _db = null;

/**
 * Credential strategy (in priority order):
 *   1. Emulator  - no credentials wanted; FIRESTORE_EMULATOR_HOST routes calls.
 *   2. Runtime   - Cloud Functions / VPS provide ADC, so plain projectId is enough.
 *   3. Local     - a service-account key in .env (FIREBASE_CLIENT_EMAIL +
 *                  FIREBASE_PRIVATE_KEY) authenticates against the real project.
 */
function appOptions() {
  const projectId = config.firebase.projectId || process.env.GCLOUD_PROJECT || 'demo-northbridge';
  const emulating = Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT === 'demo-northbridge');
  const useServiceAccount = !emulating && config.firebase.clientEmail && config.firebase.privateKey;
  if (useServiceAccount) {
    return {
      credential: cert({
        projectId,
        clientEmail: config.firebase.clientEmail,
        privateKey: config.firebase.privateKey,
      }),
      projectId,
    };
  }
  return { projectId };
}

export function initFirestore() {
  if (_db) return _db;
  const app = getApps().length ? getApp() : initializeApp(appOptions());
  _db = getFirestore(app);
  _db.settings({ ignoreUndefinedProperties: true });
  return _db;
}

export function db() {
  return _db ?? initFirestore();
}

/** Reset the cached handle (tests only). */
export function closeFirestore() {
  _db = null;
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

export const C = {
  settings: 'settings',
  admins: 'admins',
  customers: 'customers',
  banks: 'banks',
  sessions: 'sessions',
  transfers: 'transfers',
  ledger: 'ledger_entries',
  receipts: 'receipts',
  audit: 'audit_logs',
  counters: 'counters',
  refs: 'unique_refs',
  loginChallenges: 'login_challenges',
};

export { FieldValue, AggregateField, FieldPath };

/* -------------------------------------------------------------------------- */
/* Aggregations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Document count of any query. Billed and latency-cost as a *single* read
 * regardless of how many documents match, so dashboards must use this instead
 * of fetching the collection and counting in JavaScript.
 */
export async function countOf(query) {
  return (await query.count().get()).data().count;
}

/**
 * Sum of a numeric field across any query. Also billed as a single read.
 * Returns 0 when nothing matches.
 */
export async function sumOf(query, field) {
  const snap = await query.aggregate({ value: AggregateField.sum(field) }).get();
  return snap.data().value ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/** UTC ISO-8601 with milliseconds stripped - identical to the old nowIso(). */
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/* -------------------------------------------------------------------------- */
/* References                                                                  */
/* -------------------------------------------------------------------------- */

export function coll(name) {
  return db().collection(name);
}

export function docRef(name, id) {
  return db().collection(name).doc(String(id));
}

/** Firestore doc ids may not contain '/'. Unique keys are namespaced with ':'. */
export function encodeKey(key) {
  return String(key).replace(/\//g, '%2F');
}

/** Document reference for a unique value in the shared index collection. */
export function uniqueRef(key) {
  return db().collection(C.refs).doc(encodeKey(key));
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run `fn` inside a Firestore transaction. `fn` receives the transaction, may
 * be async, and MUST perform all reads before any writes (the SDK rejects the
 * opposite). Firestore retries the body on contention, so `fn` must not mutate
 * application state.
 *
 * @template T
 * @param {(txn: import('firebase-admin/firestore').Transaction) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function transaction(fn) {
  return db().runTransaction((txn) => fn(txn));
}

/* -------------------------------------------------------------------------- */
/* Document reads / writes (non-transactional)                                 */
/* -------------------------------------------------------------------------- */

/** Numeric ids come back as strings from Firestore; restore numbers. */
export function coerceId(id) {
  return /^\d+$/.test(id) ? Number(id) : id;
}

/** Map a query snapshot to plain `{ id, ...data }` rows. */
export function snapRows(snap) {
  return snap.docs.map((doc) => ({ id: coerceId(doc.id), ...doc.data() }));
}

/** Read one document by id. Returns `{ id, ...data }` or null. */
export async function getById(collection, id) {
  if (id === undefined || id === null || id === '') return null;
  const snap = await docRef(collection, id).get();
  return snap.exists ? { id: coerceId(snap.id), ...snap.data() } : null;
}

/** Write (replace or merge) a document by id. */
export async function setById(collection, id, data, { merge = false } = {}) {
  await docRef(collection, id).set(data, { merge });
}

/** Delete a document. */
export async function deleteById(collection, id) {
  await docRef(collection, id).delete();
}

/* -------------------------------------------------------------------------- */
/* Transaction read helpers                                                    */
/* -------------------------------------------------------------------------- */

/** Read one document inside a transaction. Returns `{ id, ...data }` or null. */
export async function txnGetById(txn, collection, id) {
  if (id === undefined || id === null || id === '') return null;
  const snap = await txn.get(docRef(collection, id));
  return snap.exists ? { id: coerceId(snap.id), ...snap.data() } : null;
}

/** Read a raw reference inside a transaction. */
export function txnGet(txn, ref) {
  return txn.get(ref);
}

/** Read the next integer id for a sequence (does not consume it). */
export async function readCounter(txn, name) {
  const snap = await txn.get(coll(C.counters).doc(name));
  return Number(snap.exists ? snap.data().value : 0) + 1;
}

/**
 * Verify a unique value is free (or already owned by `ownerId`). Throws a
 * `unique_violation` error when it is held by someone else. Read-only: pair
 * with `claimUnique` in the write phase.
 */
export async function checkUnique(txn, key, ownerId) {
  const snap = await txn.get(uniqueRef(key));
  if (snap.exists && String(snap.data().ownerId) !== String(ownerId)) {
    const error = new Error(`unique_violation:${key}`);
    error.code = 'unique_violation';
    error.key = key;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Transaction write helpers                                                   */
/* -------------------------------------------------------------------------- */

/** Persist the consumed counter value. Must run in the write phase. */
export function bumpCounter(txn, name, value) {
  txn.set(coll(C.counters).doc(name), { value }, { merge: true });
}

/** Reserve a unique value for `ownerId`. Write-phase counterpart of checkUnique. */
export function claimUnique(txn, key, ownerId) {
  txn.set(uniqueRef(key), { key, ownerId: String(ownerId) });
}

/** Release a unique value (row deleted / value changed). */
export function releaseUnique(txn, key) {
  txn.delete(uniqueRef(key));
}

/** Transactional write. */
export function txnSet(txn, collection, id, data, { merge = false } = {}) {
  txn.set(docRef(collection, id), data, { merge });
}

/** Transactional delete. */
export function txnDelete(txn, collection, id) {
  txn.delete(docRef(collection, id));
}
