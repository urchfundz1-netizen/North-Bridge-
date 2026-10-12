/**
 * Firestore access layer (replaces db/connection.js).
 *
 * SQLite gave us three things Firestore does not: SQL constraints, triggers,
 * and synchronous transactions. This module rebuilds the primitives the rest
 * of the server needs so the services can be ported without every call site
 * inventing its own convention:
 *
 *   * `transaction(fn)`        - async ACID transaction (like BEGIN IMMEDIATE).
 *   * `nextId(name)`           - auto-increment integer ids via a counter doc,
 *                                so numeric ids survive the migration.
 *   * `claimUnique(key,id)`    - a stand-in for UNIQUE constraints: a dedicated
 *                                index document per unique value, claimed and
 *                                released inside the same transaction as the row
 *                                it protects. Firestore has no unique index, so
 *                                this is how "one account per email" is kept.
 *
 * Document ids are the same numeric keys the SQLite schema used (stringified),
 * so serializers, URLs and the Firestore mirror keep working unchanged.
 */

import { initializeApp, getApps, getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { config } from '../core/config.js';

/* -------------------------------------------------------------------------- */
/* Init                                                                        */
/* -------------------------------------------------------------------------- */

let _db = null;

export function initFirestore() {
  if (_db) return _db;
  const app = getApps().length
    ? getApp()
    : initializeApp({ projectId: config.firebase.projectId || process.env.GCLOUD_PROJECT || 'demo-northbridge' });
  _db = getFirestore(app);
  // Match SQLite's "everything is UTC ISO" convention the serializers expect.
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
};

export { FieldValue };

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/** UTC ISO-8601 with milliseconds stripped - identical to the old nowIso(). */
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/* -------------------------------------------------------------------------- */
/* Transactions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run `fn` inside a Firestore transaction. `fn` receives the transaction and
 * may be async. Firestore retries the whole body on contention, so `fn` must be
 * free of side effects other than reads/writes on `txn`.
 *
 * @template T
 * @param {(txn: import('firebase-admin/firestore').Transaction) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function transaction(fn) {
  return db().runTransaction((txn) => fn(txn));
}

/* -------------------------------------------------------------------------- */
/* Ids                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Allocate the next integer id for a named sequence, inside a transaction.
 * @param {import('firebase-admin/firestore').Transaction} txn
 * @param {string} name e.g. 'customers'
 * @returns {Promise<number>}
 */
export async function nextId(txn, name) {
  const ref = db().collection(C.counters).doc(name);
  const snap = await txn.get(ref);
  const value = Number(snap.exists ? snap.data().value : 0) + 1;
  txn.set(ref, { value }, { merge: true });
  return value;
}

/* -------------------------------------------------------------------------- */
/* Uniqueness                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reserve a unique value (email, account number, reference, ...). Throws if it
 * is already held by a different owner. Must be called inside a transaction,
 * before writing the row that owns the value.
 *
 * @param {import('firebase-admin/firestore').Transaction} txn
 * @param {string} key   e.g. 'customerEmail:ada@example.com'
 * @param {number|string} ownerId the row id that owns this value
 */
export async function claimUnique(txn, key, ownerId) {
  const ref = db().collection(C.refs).doc(encodeKey(key));
  const snap = await txn.get(ref);
  if (snap.exists && String(snap.data().ownerId) !== String(ownerId)) {
    const error = new Error(`unique_violation:${key}`);
    error.code = 'unique_violation';
    error.key = key;
    throw error;
  }
  txn.set(ref, { key, ownerId: String(ownerId) });
}

/** Release a unique value (row deleted / value changed). */
export function releaseUnique(txn, key) {
  txn.delete(db().collection(C.refs).doc(encodeKey(key)));
}

/** Firestore doc ids may not contain '/'. Index keys are namespaced with ':'. */
function encodeKey(key) {
  return key.replace(/\//g, '%2F');
}

/* -------------------------------------------------------------------------- */
/* Reads / writes                                                              */
/* -------------------------------------------------------------------------- */

/** Read one document by id. Returns `{ id, ...data }` or null. */
export async function getById(collection, id) {
  if (id === undefined || id === null || id === '') return null;
  const snap = await db().collection(collection).doc(String(id)).get();
  return snap.exists ? { id: coerceId(snap.id), ...snap.data() } : null;
}

/** Read one document inside a transaction. */
export async function txnGetById(txn, collection, id) {
  if (id === undefined || id === null || id === '') return null;
  const snap = await txn.get(db().collection(collection).doc(String(id)));
  return snap.exists ? { id: coerceId(snap.id), ...snap.data() } : null;
}

/** Write (replace or merge) a document by id. */
export async function setById(collection, id, data, { merge = false } = {}) {
  await db().collection(collection).doc(String(id)).set(data, { merge });
}

/** Transactional write. */
export function txnSet(txn, collection, id, data, { merge = false } = {}) {
  txn.set(db().collection(collection).doc(String(id)), data, { merge });
}

/** Transactional create from a plain object, allocating an id first. */
export async function txnCreate(txn, collection, data) {
  const id = await nextId(txn, collection);
  txn.set(db().collection(collection).doc(String(id)), data);
  return id;
}

/** Delete a document. */
export async function deleteById(collection, id) {
  await db().collection(collection).doc(String(id)).delete();
}

/** Numeric ids come back as strings from Firestore; restore numbers. */
function coerceId(id) {
  return /^\d+$/.test(id) ? Number(id) : id;
}
