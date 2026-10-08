/**
 * Firestore mirror (server-side only, via firebase-admin).
 *
 * SQLite stays the source of truth for every balance, transfer and audit
 * entry; this module copies committed rows into Cloud Firestore as a read
 * replica. Three rules shape the design:
 *
 *   1. Mirrors fire only AFTER the SQLite transaction has committed - the
 *      bank's own record never waits on a network call.
 *   2. A mirror failure never reaches the caller. Firebase being slow, down or
 *      misconfigured must not fail a transfer. Failures go to stderr.
 *   3. Everything is a no-op unless FIREBASE_ENABLED=1, and always a no-op in
 *      tests, so `npm test` stays offline and deterministic.
 *
 * The browser never talks to Firebase: only this server holds credentials, so
 * the security rules can deny all client access (see firestore.rules).
 */

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from '../core/config.js';
import { one, many } from '../db/connection.js';

let firestore = null;
let initFailed = false;
const loggedFailures = new Map();

/** Columns never copied into Firestore, whatever the row. */
const CUSTOMER_OMIT = ['password_hash', 'transfer_pin_hash'];
const ADMIN_OMIT = ['password_hash'];

/** Per-table secret columns, shared with the backfill script. */
export const MIRROR_OMIT = {
  customers: CUSTOMER_OMIT,
  admins: ADMIN_OMIT,
};

/** Lazily create (or reuse) the Firestore client. Returns null when off. */
function client() {
  if (!config.firebase.enabled || initFailed) return null;
  if (firestore) return firestore;
  try {
    const app = getApps().length
      ? getApp()
      : initializeApp({
          credential: cert({
            projectId: config.firebase.projectId,
            clientEmail: config.firebase.clientEmail,
            privateKey: config.firebase.privateKey,
          }),
          projectId: config.firebase.projectId,
        });
    firestore = getFirestore(app);
    return firestore;
  } catch (error) {
    initFailed = true;
    console.error('[firestore] initialisation failed, mirror disabled for this process:', error.message);
    return null;
  }
}

/**
 * Report mirror status once at boot. Returns true when the mirror is live so
 * callers (or an operator reading the log) can tell the difference between
 * "off" and "on but broken".
 */
export function initFirestore() {
  if (!config.firebase.enabled) {
    console.log('  Firestore mirror: disabled');
    return false;
  }
  const ok = Boolean(client());
  console.log(
    ok
      ? `  Firestore mirror: active (project ${config.firebase.projectId})`
      : '  Firestore mirror: FAILED to initialise - see error above',
  );
  return ok;
}

const MAX_LOGS_PER_COLLECTION = 3;

function logFailure(where, error) {
  const count = (loggedFailures.get(where) ?? 0) + 1;
  loggedFailures.set(where, count);
  if (count <= MAX_LOGS_PER_COLLECTION) {
    console.error(`[firestore] mirror failed (${where}):`, error.message);
    if (count === MAX_LOGS_PER_COLLECTION) {
      console.error('[firestore] further failures for this collection are suppressed until restart.');
    }
  }
}

/**
 * Mirror one row. `id` becomes the document id (stringified), so Firestore
 * ids line up with SQLite primary keys for easy reconciliation.
 *
 * Never throws; call it right after the SQLite commit. Returns the pending
 * write promise so batch callers (the backfill) can await it - request paths
 * simply ignore it, and failures are logged by the attached handler.
 *
 * @param {string} collection e.g. 'transfers'
 * @param {number|string} id  SQLite primary key
 * @param {object} data       row to write (must not contain `undefined`)
 * @returns {Promise<void>|null} null when the mirror is off
 */
export function mirror(collection, id, data) {
  const target = client();
  if (!target) return null;
  try {
    const payload = { ...data, mirrored_at: new Date().toISOString() };
    return target
      .collection(collection)
      .doc(String(id))
      .set(payload)
      .catch((error) => logFailure(`${collection}/${id}`, error));
  } catch (error) {
    logFailure(`${collection}/${id}`, error);
    return null;
  }
}

/** Remove a mirrored document (used when a row is deactivated/deleted). */
export function unmirror(collection, id) {
  const target = client();
  if (!target) return null;
  try {
    return target
      .collection(collection)
      .doc(String(id))
      .delete()
      .catch((error) => logFailure(`${collection}/${id} (delete)`, error));
  } catch (error) {
    logFailure(`${collection}/${id} (delete)`, error);
    return null;
  }
}

/**
 * Copy a SQLite row into Firestore with secret columns removed.
 * Stripped keys are deleted outright (never sent as `undefined`, which
 * Firestore rejects).
 *
 * @param {string} collection
 * @param {object} row
 * @param {string[]} [omitKeys] e.g. ['password_hash', 'transfer_pin_hash']
 */
export function mirrorRow(collection, row, omitKeys = []) {
  if (!row || row.id === undefined || row.id === null) return null;
  const copy = { ...row };
  for (const key of omitKeys) delete copy[key];
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) delete copy[key];
  }
  return mirror(collection, row.id, copy);
}

/* -------------------------------------------------------------------------- */
/* Convenience wrappers for rows that need re-reading or secret-stripping.    */
/* -------------------------------------------------------------------------- */

/** Mirror a customer row, minus password/PIN hashes. */
export function mirrorCustomerById(customerId) {
  const row = one('SELECT * FROM customers WHERE id = ?', [customerId]);
  return row ? mirrorRow('customers', row, CUSTOMER_OMIT) : null;
}

/** Mirror an admin row, minus the password hash. */
export function mirrorAdminById(adminId) {
  const row = one('SELECT * FROM admins WHERE id = ?', [adminId]);
  return row ? mirrorRow('admins', row, ADMIN_OMIT) : null;
}

/** Mirror a single ledger entry by primary key. */
export function mirrorLedgerEntryById(entryId) {
  const row = one('SELECT * FROM ledger_entries WHERE id = ?', [entryId]);
  return row ? mirrorRow('ledger_entries', row) : null;
}

/**
 * Mirror every ledger entry a transfer produced. Call AFTER the surrounding
 * transaction commits: entries are written inside it and would not exist on a
 * rollback.
 */
export function mirrorLedgerEntriesForTransfer(transferId) {
  return Promise.all(
    many('SELECT * FROM ledger_entries WHERE transfer_id = ?', [transferId]).map((row) =>
      mirrorRow('ledger_entries', row),
    ),
  );
}
