/**
 * Test harness (Firestore emulator).
 *
 * Each test file runs in its own process (see `npm test`, which wraps the run
 * in `firebase emulators:exec`). Before every file the harness wipes the
 * emulator's collections and re-seeds reference data, so files are isolated and
 * can run in any order without leaking state.
 *
 * The exported `getCustomer` / `countTransfers` / `latestAudit` helpers replace
 * the raw SQL the suite used to run against SQLite: assertions now read the
 * same documents the services write.
 */

import { randomUUID } from 'node:crypto';

// Must be set before any module reads config.js.
process.env.NODE_ENV = 'test';
process.env.NB_TEST = '1';
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-to-pass-validation';
process.env.COOKIE_SECURE = '0';
process.env.REQUIRE_TRANSFER_APPROVAL = '1';
process.env.TRANSFER_FEE_CENTS = '150';

// Point firebase-admin at the emulators. `firebase emulators:exec` normally sets
// these, but pinning them keeps `npm run test:unit` usable when the emulators are
// already running, and guarantees the admin SDK never reaches for real creds.
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
process.env.FIREBASE_PROJECT_ID = 'demo-northbridge';
process.env.GCLOUD_PROJECT = 'demo-northbridge';
process.env.FIREBASE_STORAGE_BUCKET = 'demo-northbridge.appspot.com';

const {
  db,
  C,
  nowIso,
  coll,
  getById,
  setById,
  transaction,
  readCounter,
  bumpCounter,
  txnSet,
  closeFirestore,
  initFirestore,
  coerceId,
  snapRows,
} = await import('../src/db/firestore.js');
const { bootstrap } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const { hashSecret } = await import('../src/core/crypto.js');
const { generateAccountNumber } = await import('../src/core/identifiers.js');
const { clearSettingsCache, loadSettings, setSetting } = await import('../src/services/settings.js');

let app = null;
let server = null;
let baseUrl = null;

/** Delete every document in every collection (the emulator starts empty). */
async function wipeFirestore() {
  const collections = await db().listCollections();
  for (const collection of collections) {
    let refs = await collection.listDocuments();
    while (refs.length) {
      const batch = db().batch();
      refs.forEach((ref) => batch.delete(ref));
      await batch.commit();
      refs = await collection.listDocuments();
    }
  }
}

/** Build an isolated app against a freshly seeded emulator database. */
export async function createTestApp() {
  closeFirestore();
  initFirestore();
  await wipeFirestore();
  clearSettingsCache();
  await bootstrap({ silent: true });
  await loadSettings();
  app = createApp({ serveClient: false });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

export async function destroyTestApp() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  app = null;
  closeFirestore();
}

export function getApp() {
  return app;
}

/**
 * Minimal HTTP client that keeps cookies and tracks the CSRF token, mirroring
 * how the real SPA behaves.
 */
export class ApiClient {
  constructor(url = baseUrl) {
    this.baseUrl = url;
    this.cookies = new Map();
    this.csrfToken = null;
  }

  storeCookies(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(method, path, body, { headers = {}, raw = false, withCsrf = true } = {}) {
    const finalHeaders = { ...headers };

    const cookie = this.cookieHeader();
    if (cookie) finalHeaders.Cookie = cookie;

    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    if (withCsrf && this.csrfToken && !['GET', 'HEAD'].includes(method)) {
      finalHeaders['X-CSRF-Token'] = this.csrfToken;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: finalHeaders,
      body: payload,
      redirect: 'manual',
    });

    this.storeCookies(response);

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (raw) return { status: response.status, body: text, json, headers: response.headers };

    // Adopt the CSRF token the server hands back on sign-in / session probe.
    if (json?.csrfToken) this.csrfToken = json.csrfToken;

    return { status: response.status, body: json, headers: response.headers };
  }

  get(path, options) {
    return this.request('GET', path, undefined, options);
  }

  post(path, body, options) {
    return this.request('POST', path, body, options);
  }

  patch(path, body, options) {
    return this.request('PATCH', path, body, options);
  }

  delete(path, body, options) {
    return this.request('DELETE', path, body, options);
  }

  /* ---------------- convenience flows ---------------- */

  async registerCustomer(overrides = {}) {
    const password = overrides.password ?? 'CustomerPass#2024';
    const payload = {
      fullName: 'Ada Lovelace',
      dateOfBirth: '1990-05-14',
      email: `customer-${randomUUID().slice(0, 8)}@example.com`,
      phone: '+1 555 0100',
      addressLine1: '12 Analytical Way',
      addressLine2: 'Suite 4',
      city: 'London',
      stateRegion: 'Greater London',
      postalCode: 'NW1 6XE',
      country: 'United Kingdom',
      accountType: 'checking',
      password,
      confirmPassword: password,
      transferPin: '4321',
      confirmTransferPin: '4321',
      acceptTerms: true,
      ...overrides,
    };

    const response = await this.post('/api/auth/register', payload);
    if (response.status !== 201) {
      throw new Error(`registerCustomer failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return { customer: response.body.customer, credentials: payload, client: this };
  }

  async loginCustomer(email, password) {
    const response = await this.post('/api/auth/login', { email, password });
    if (response.status !== 200) {
      throw new Error(`loginCustomer failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body;
  }

  async loginAdmin(email = 'admin@northbridge.bank', password = 'AdminPass#2024') {
    const response = await this.post('/api/admin/auth/login', { email, password });
    if (response.status !== 200) {
      throw new Error(`loginAdmin failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body;
  }
}

/* -------------------------------------------------------------------------- */
/* Direct Firestore seeding (bypasses the HTTP layer)                          */
/* -------------------------------------------------------------------------- */

/** Create an administrator directly, bypassing the login rate limiter. */
export async function createAdmin({
  email = `admin-${randomUUID().slice(0, 8)}@northbridge.bank`,
  password = 'AdminPass#2024',
  role = 'superadmin',
} = {}) {
  const passwordHash = await hashSecret(password);
  const now = nowIso();

  const id = await transaction(async (txn) => {
    const nextId = await readCounter(txn, C.admins);
    bumpCounter(txn, C.admins, nextId);
    txnSet(txn, C.admins, nextId, {
      id: nextId,
      email,
      full_name: 'Test Administrator',
      password_hash: passwordHash,
      role,
      status: 'active',
      failed_attempts: 0,
      locked_until: null,
      last_login_at: null,
      created_at: now,
      updated_at: now,
    });
    return nextId;
  });

  return { id, email, password, role };
}

/** Create a customer directly, optionally with an opening balance. */
export async function createCustomer({
  email = `user-${randomUUID().slice(0, 8)}@example.com`,
  password = 'CustomerPass#2024',
  transferPin = '4321',
  balanceCents = 0,
  status = 'active',
  fullName = 'Grace Hopper',
  accountType = 'checking',
} = {}) {
  const accountNumber = generateAccountNumber();
  const now = nowIso();
  const [passwordHash, transferPinHash] = await Promise.all([
    hashSecret(password),
    hashSecret(transferPin),
  ]);

  const id = await transaction(async (txn) => {
    const nextId = await readCounter(txn, C.customers);
    const entryId = balanceCents > 0 ? await readCounter(txn, C.ledger) : null;
    bumpCounter(txn, C.customers, nextId);
    txnSet(txn, C.customers, nextId, {
      account_number: accountNumber,
      full_name: fullName,
      date_of_birth: '1990-01-01',
      email,
      phone: '+1 555 0100',
      address_line1: '1 Test Street',
      address_line2: null,
      city: 'Testville',
      state_region: 'TS',
      postal_code: '00000',
      country: 'United States',
      account_type: accountType,
      password_hash: passwordHash,
      transfer_pin_hash: transferPinHash,
      transfer_pin_hash_updated_at: now,
      transfer_pin_failed_attempts: 0,
      transfer_pin_locked_until: null,
      failed_login_attempts: 0,
      locked_until: null,
      status,
      status_reason: null,
      status_changed_at: null,
      status_changed_by_admin_id: null,
      balance_cents: balanceCents,
      profile_picture: null,
      last_login_at: null,
      created_at: now,
      updated_at: now,
    });

    // Seed the opening balance through a real ledger document so the production
    // invariant - sum(ledger) === balance - holds for test data too.
    if (balanceCents > 0) {
      bumpCounter(txn, C.ledger, entryId);
      txnSet(txn, C.ledger, entryId, {
        customer_id: nextId,
        amount_cents: balanceCents,
        balance_after_cents: balanceCents,
        entry_type: 'deposit',
        transfer_id: null,
        admin_id: null,
        description: 'Opening balance',
        reference_number: null,
        created_at: now,
      });
    }

    return nextId;
  });

  return { id, email, password, transferPin, accountNumber, status, balanceCents, fullName };
}

/* -------------------------------------------------------------------------- */
/* Firestore inspection helpers (the old `one` / `run` replacements)           */
/* -------------------------------------------------------------------------- */

export const getCustomer = (id) => getById(C.customers, id);
export const getAdmin = (id) => getById(C.admins, id);
export const getTransfer = (id) => getById(C.transfers, id);
export const getBank = (id) => getById(C.banks, id);

export function updateCustomer(id, patch) {
  return setById(C.customers, id, patch, { merge: true });
}

export function updateAdmin(id, patch) {
  return setById(C.admins, id, patch, { merge: true });
}

/** All rows of a collection as `{ id, ...data }`, sorted by numeric id asc. */
async function allRows(collection) {
  const snap = await coll(collection).get();
  return snapRows(snap).sort((a, b) => Number(a.id) - Number(b.id));
}

/** The first seeded bank, used as a transfer destination. */
export async function firstBank() {
  const rows = (await allRows(C.banks)).filter((bank) => bank.is_active);
  return rows[0] ?? null;
}

/** A bank matching every key/value pair (e.g. `{ supports_wire: 1, supports_local: 0 }`). */
export async function findBank(match = {}) {
  const rows = await allRows(C.banks);
  return (
    rows.find((bank) =>
      Object.entries(match).every(([key, value]) => bank[key] === value),
    ) ?? null
  );
}

export async function countTransfers(customerId) {
  const snap = await coll(C.transfers).where('customer_id', '==', customerId).get();
  return snap.size;
}

export async function latestTransfer(customerId) {
  const snap = await coll(C.transfers).where('customer_id', '==', customerId).get();
  const rows = snapRows(snap).sort((a, b) => Number(b.id) - Number(a.id));
  return rows[0] ?? null;
}

/** Change a setting through the service (also refreshes the in-process cache). */
export const setSettingValue = (key, value) => setSetting(key, value);

export async function countReceipts(match = {}) {
  let query = coll(C.receipts);
  for (const [key, value] of Object.entries(match)) query = query.where(key, '==', value);
  return (await query.get()).size;
}

export async function listLedger(customerId, match = {}) {
  const snap = await coll(C.ledger).where('customer_id', '==', customerId).get();
  let rows = snapRows(snap);
  for (const [key, value] of Object.entries(match)) {
    rows = rows.filter((row) => row[key] === value);
  }
  return rows.sort((a, b) => Number(b.id) - Number(a.id));
}

export async function latestLedgerEntry(customerId) {
  const rows = await listLedger(customerId);
  return rows[0] ?? null;
}

export async function sumLedger(customerId) {
  const rows = await listLedger(customerId);
  return rows.reduce((total, row) => total + (row.amount_cents ?? 0), 0);
}

export async function getSettingValue(key) {
  const snap = await coll(C.settings).doc(key).get();
  return snap.exists ? snap.data().value : null;
}

/** Newest audit rows first, optionally filtered by action and/or target id. */
export async function listAudit({ action, targetId } = {}) {
  const rows = await allRows(C.audit);
  return rows
    .filter((row) => (action === undefined || row.action === action))
    .filter((row) => (targetId === undefined || String(row.target_id) === String(targetId)))
    .sort((a, b) => Number(b.id) - Number(a.id));
}

export async function latestAudit(filter = {}) {
  return (await listAudit(filter))[0] ?? null;
}

export { db, C, coerceId, nowIso };
