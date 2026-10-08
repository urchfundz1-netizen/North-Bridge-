/**
 * Test harness.
 *
 * Each test file gets a fresh in-memory database with the schema applied, so
 * files are isolated and can run in any order.
 */

import { randomUUID } from 'node:crypto';

// Must be set before any module reads config.js.
process.env.NODE_ENV = 'test';
process.env.NB_TEST = '1';
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-to-pass-validation';
process.env.COOKIE_SECURE = '0';
process.env.REQUIRE_TRANSFER_APPROVAL = '1';
process.env.TRANSFER_FEE_CENTS = '150';

const { getDb, closeDb, one, run, nowIso } = await import('../src/db/connection.js');
const { migrate } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const { hashSecret } = await import('../src/core/crypto.js');
const { generateUniqueAccountNumber } = await import('../src/core/identifiers.js');
const { clearSettingsCache } = await import('../src/services/settings.js');

let app = null;
let server = null;
let baseUrl = null;

/** Build an isolated app against a fresh in-memory database. */
export async function createTestApp() {
  closeDb();
  getDb();
  migrate({ silent: true });
  clearSettingsCache();
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
  closeDb();
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

/** Create an administrator directly, bypassing the login rate limiter. */
export async function createAdmin({
  email = `admin-${randomUUID().slice(0, 8)}@northbridge.bank`,
  password = 'AdminPass#2024',
  role = 'superadmin',
} = {}) {
  const passwordHash = await hashSecret(password);
  const inserted = run(
    `INSERT INTO admins (email, full_name, password_hash, role) VALUES (?, ?, ?, ?)`,
    [email, 'Test Administrator', passwordHash, role],
  );
  return { id: Number(inserted.lastInsertRowid), email, password, role };
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
  const accountNumber = generateUniqueAccountNumber();
  const inserted = run(
    `INSERT INTO customers
       (account_number, full_name, date_of_birth, email, phone, address_line1,
        city, state_region, postal_code, country, account_type, password_hash,
        transfer_pin_hash, status, balance_cents)
     VALUES (?, ?, '1990-01-01', ?, '+1 555 0100', '1 Test Street',
             'Testville', 'TS', '00000', 'United States', ?, ?, ?, ?, ?)`,
    [
      accountNumber,
      fullName,
      email,
      accountType,
      await hashSecret(password),
      await hashSecret(transferPin),
      status,
      balanceCents,
    ],
  );

  const id = Number(inserted.lastInsertRowid);

  // Seed the opening balance through a real ledger row so the production
  // invariant - sum(ledger) === balance - holds for test data too.
  if (balanceCents > 0) {
    run(
      `INSERT INTO ledger_entries
         (customer_id, amount_cents, balance_after_cents, entry_type, description)
       VALUES (?, ?, ?, 'deposit', 'Opening balance')`,
      [id, balanceCents, balanceCents],
    );
  }

  return { id, email, password, transferPin, accountNumber, status, balanceCents, fullName };
}

/** The first seeded bank, used as a transfer destination. */
export function firstBank() {
  return one('SELECT * FROM banks WHERE is_active = 1 ORDER BY id LIMIT 1');
}

export { one, run, nowIso, getDb };
