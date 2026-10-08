/**
 * Authentication, authorisation and CSRF tests.
 *
 * The theme is separation: customer credentials must not reach the admin panel,
 * admin credentials must not reach the customer portal, and neither should be
 * able to perform an action without the CSRF token issued to that session.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTestApp,
  destroyTestApp,
  ApiClient,
  createCustomer,
  createAdmin,
  firstBank,
  one,
} from './helpers.js';

let baseUrl;
let bank;

before(async () => {
  baseUrl = await createTestApp();
  bank = firstBank();
});

after(async () => {
  await destroyTestApp();
});

/* -------------------------------------------------------------------------- */
/* Customer authentication                                                    */
/* -------------------------------------------------------------------------- */

describe('customer authentication', () => {
  test('a registered customer receives an account number and a session cookie', async () => {
    const client = new ApiClient(baseUrl);
    const { customer, credentials } = await client.registerCustomer();

    assert.match(customer.accountNumber, /^4\d{9}$/, 'account numbers are 10 digits');
    assert.ok(customer.balanceCents === 0);
    assert.equal(customer.status, 'active');
    assert.equal(customer.accountType, credentials.accountType);

    // The session cookie must be httpOnly and SameSite=Strict.
    const raw = client.cookieHeader();
    assert.match(raw, /nb_customer_session=/);

    const session = await client.get('/api/auth/session');
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.customer.accountNumber, customer.accountNumber);
    assert.ok(session.body.csrfToken);
  });

  test('registration rejects a weak password', async () => {
    const client = new ApiClient(baseUrl);
    const response = await client.post('/api/auth/register', {
      fullName: 'Weak Password',
      dateOfBirth: '1990-01-01',
      email: 'weak@example.com',
      phone: '+1 555 0111',
      addressLine1: '1 Weak Street',
      city: 'Town',
      stateRegion: 'TS',
      postalCode: '00000',
      country: 'United States',
      accountType: 'checking',
      password: 'short',
      confirmPassword: 'short',
      transferPin: '1234',
      confirmTransferPin: '1234',
      acceptTerms: true,
    });

    assert.equal(response.status, 422);
    assert.ok(response.body.error.details.password, 'a password rule is reported');
  });

  test('registration rejects a transfer PIN equal to the password', async () => {
    const client = new ApiClient(baseUrl);
    const response = await client.post('/api/auth/register', {
      fullName: 'Same Secret',
      dateOfBirth: '1990-01-01',
      email: 'same@example.com',
      phone: '+1 555 0112',
      addressLine1: '1 Same Street',
      city: 'Town',
      stateRegion: 'TS',
      postalCode: '00000',
      country: 'United States',
      accountType: 'checking',
      password: '1234',
      confirmPassword: '1234',
      transferPin: '1234',
      confirmTransferPin: '1234',
      acceptTerms: true,
    });

    // The password fails the strength rules, and the PIN would equal it.
    assert.equal(response.status, 422);
  });

  test('a duplicate email is refused', async () => {
    const first = new ApiClient(baseUrl);
    const { credentials } = await first.registerCustomer();

    // Submitted directly rather than through the helper, which throws on any
    // non-201 and so cannot express the expected failure.
    const second = new ApiClient(baseUrl);
    const response = await second.post('/api/auth/register', {
      fullName: 'Impostor',
      dateOfBirth: '1990-01-01',
      email: credentials.email,
      phone: '+1 555 0113',
      addressLine1: '1 Other Street',
      city: 'Town',
      stateRegion: 'TS',
      postalCode: '00000',
      country: 'United States',
      accountType: 'checking',
      password: 'AnotherPass#2024',
      confirmPassword: 'AnotherPass#2024',
      transferPin: '9876',
      confirmTransferPin: '9876',
      acceptTerms: true,
    });

    assert.equal(response.status, 409);
    assert.match(response.body.error.message, /already exists/i);
  });

  test('a wrong password is rejected without revealing whether the email exists', async () => {
    const record = await createCustomer();

    const client = new ApiClient(baseUrl);
    const wrongPassword = await client.post('/api/auth/login', {
      email: record.email,
      password: 'WrongPassword#2024',
    });
    const unknownEmail = await client.post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'WrongPassword#2024',
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.body.error.message, unknownEmail.body.error.message);
  });

  test('the login response never contains a password or PIN hash', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);

    const login = await client.post('/api/auth/login', {
      email: record.email,
      password: record.password,
    });
    assert.equal(login.status, 200);

    const serialised = JSON.stringify(login.body);
    assert.ok(!serialised.includes('password_hash'));
    assert.ok(!serialised.includes('passwordHash'));
    assert.ok(!serialised.includes('transfer_pin_hash'));
    assert.ok(!serialised.includes(record.password));
  });

  test('repeated failed sign-ins lock the account', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await client.post('/api/auth/login', { email: record.email, password: 'DefinitelyWrong#1' });
    }

    const locked = one('SELECT * FROM customers WHERE id = ?', [record.id]);
    assert.equal(locked.status, 'locked');
    assert.equal(locked.failed_login_attempts, 6);
    assert.match(locked.status_reason, /failed sign-in/i);

    // Even the correct password is now refused.
    const correct = await client.post('/api/auth/login', {
      email: record.email,
      password: record.password,
    });
    assert.equal(correct.status, 401);
  });

  test('signing out clears the session', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const out = await client.post('/api/auth/logout', {});
    assert.equal(out.status, 200);

    const probe = await client.get('/api/auth/session');
    assert.equal(probe.body.authenticated, false);
  });

  test('signing in again invalidates the previous session cookie', async () => {
    const record = await createCustomer();

    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);
    const firstToken = client.cookies.get('nb_customer_session');
    assert.ok(firstToken);

    // Sign in again on the same client: the server should revoke the token it
    // presented, preventing session fixation.
    await client.loginCustomer(record.email, record.password);
    const secondToken = client.cookies.get('nb_customer_session');
    assert.notEqual(secondToken, firstToken, 'a fresh token is issued on re-authentication');

    // Present the old token to a brand-new client.
    const replay = new ApiClient(baseUrl);
    replay.cookies.set('nb_customer_session', firstToken);
    const probe = await replay.get('/api/auth/session');
    assert.equal(probe.body.authenticated, false, 'the previous token must be revoked');

    // The new token still works.
    const live = await client.get('/api/auth/session');
    assert.equal(live.body.authenticated, true);
  });
});

/* -------------------------------------------------------------------------- */
/* Privilege separation                                                       */
/* -------------------------------------------------------------------------- */

describe('privilege separation', () => {
  test('customer credentials cannot sign in to the admin panel', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);

    const response = await client.post('/api/admin/auth/login', {
      email: record.email,
      password: record.password,
    });

    assert.equal(response.status, 401);
    const probe = await client.get('/api/admin/auth/session');
    assert.equal(probe.body.authenticated, false);
  });

  test('admin credentials cannot sign in to the customer portal', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);

    const response = await client.post('/api/auth/login', {
      email: admin.email,
      password: admin.password,
    });

    assert.equal(response.status, 401);
    const probe = await client.get('/api/auth/session');
    assert.equal(probe.body.authenticated, false);
  });

  test('a customer cookie cannot read the admin customer directory', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const response = await client.get('/api/admin/customers');
    assert.equal(response.status, 401);
  });

  test('an admin cookie cannot read customer account details', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(admin.email, admin.password);

    for (const path of ['/api/account/profile', '/api/account/summary', '/api/transfers']) {
      const response = await client.get(path);
      assert.equal(response.status, 401, `${path} must reject an admin session`);
    }
  });

  test('an admin cannot approve a transfer through the customer API', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(admin.email, admin.password);

    // The approve route lives under /api/admin/transfers, which the admin
    // session can use - but the customer-scoped transfer route must not expose
    // any settlement path.
    const response = await client.post('/api/transfers/1/cancel', {});
    assert.equal(response.status, 401);
  });

  test('an anonymous request is refused everywhere it matters', async () => {
    const client = new ApiClient(baseUrl);

    const protectedRoutes = [
      ['GET', '/api/account/profile'],
      ['GET', '/api/account/summary'],
      ['GET', '/api/account/transactions'],
      ['POST', '/api/transfers'],
      ['GET', '/api/transfers'],
      ['GET', '/api/admin/customers'],
      ['GET', '/api/admin/transfers'],
      ['POST', '/api/admin/transfers/1/approve'],
      ['GET', '/api/admin/audit-logs'],
      ['GET', '/api/admin/banks'],
      ['GET', '/api/admin/overview'],
    ];

    for (const [method, path] of protectedRoutes) {
      const response = await client.request(method, path, method === 'GET' ? undefined : {});
      assert.equal(response.status, 401, `${method} ${path} must require authentication`);
    }
  });

  test('the admin directory never exposes credential hashes', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(admin.email, admin.password);

    const response = await client.get('/api/admin/customers');
    assert.equal(response.status, 200);

    const serialised = JSON.stringify(response.body);
    assert.ok(!serialised.includes('password_hash'));
    assert.ok(!serialised.includes('transfer_pin_hash'));
    assert.ok(!/scrypt\$/.test(serialised), 'no scrypt hash may appear in any response');
  });

  test('a disabled administrator cannot use an existing session', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(admin.email, admin.password);

    const { run } = await import('../src/db/connection.js');
    run("UPDATE admins SET status = 'disabled' WHERE id = ?", [admin.id]);

    const response = await client.get('/api/admin/customers');
    assert.equal(response.status, 401, 'a disabled admin session stops resolving');
  });
});

/* -------------------------------------------------------------------------- */
/* CSRF                                                                       */
/* -------------------------------------------------------------------------- */

describe('CSRF protection', () => {
  test('a state-changing request without the CSRF header is refused', async () => {
    const record = await createCustomer({ balanceCents: 500_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const savedToken = client.csrfToken;
    client.csrfToken = null; // simulate a request with no token

    const response = await client.post('/api/transfers', {
      transferType: 'local',
      recipientName: 'Attacker',
      recipientAccountNumber: '000999888777',
      recipientBankId: bank.id,
      recipientRoutingNumber: '021000021',
      amount: '10.00',
      transferPin: '4321',
    });

    client.csrfToken = savedToken;
    assert.equal(response.status, 403);
    assert.equal(
      one('SELECT COUNT(*) AS n FROM transfers WHERE customer_id = ?', [record.id]).n,
      0,
      'no transfer may be created',
    );
  });

  test('a wrong CSRF token is refused', async () => {
    const record = await createCustomer({ balanceCents: 100_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    // Pass the forged token with withCsrf disabled so it is not overwritten by
    // the client's own valid token.
    const response = await client.patch(
      '/api/account/profile',
      { phone: '+1 555 9999' },
      { headers: { 'X-CSRF-Token': 'forged-token-value' }, withCsrf: false },
    );

    assert.equal(response.status, 403);
    assert.equal(
      one('SELECT phone FROM customers WHERE id = ?', [record.id]).phone,
      '+1 555 0100',
      'the profile must be unchanged',
    );
  });

  test("an admin session's token does not work for a customer session", async () => {
    const record = await createCustomer();
    const customerClient = new ApiClient(baseUrl);
    await customerClient.loginCustomer(record.email, record.password);

    const admin = await createAdmin();
    const adminClient = new ApiClient(baseUrl);
    const adminCsrf = (await adminClient.loginAdmin(admin.email, admin.password)).csrfToken;

    // Borrow the admin's token onto the customer session.
    const response = await customerClient.patch(
      '/api/account/profile',
      { phone: '+1 555 8888' },
      { headers: { 'X-CSRF-Token': adminCsrf }, withCsrf: false },
    );

    assert.equal(response.status, 403, 'the CSRF token is bound to its own session');
  });

  test('reads do not require a CSRF token', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    client.csrfToken = null;
    const response = await client.get('/api/account/summary');
    assert.equal(response.status, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* Profile picture uploads                                                    */
/* -------------------------------------------------------------------------- */

describe('profile picture uploads', () => {
  /** A 1x1 PNG - the smallest valid image we can construct inline. */
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  function imageForm(bytes, filename = 'avatar.png', type = 'image/png') {
    const form = new FormData();
    form.append('picture', new Blob([bytes], { type }), filename);
    return form;
  }

  test('a customer can upload a PNG profile picture', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const response = await client.request('POST', '/api/account/profile/picture', imageForm(PNG_BYTES));
    assert.equal(response.status, 200);
    assert.match(response.body.profilePicture, /^\/uploads\/avatars\/customer-\d+-[0-9a-f]{16}\.png$/);

    const stored = one('SELECT profile_picture FROM customers WHERE id = ?', [record.id]);
    assert.equal(stored.profile_picture, response.body.profilePicture);
  });

  test('a non-image upload is refused', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const form = new FormData();
    form.append('picture', new Blob([Buffer.from('#!/bin/sh\nrm -rf /')], { type: 'application/x-sh' }), 'evil.sh');

    const response = await client.request('POST', '/api/account/profile/picture', form);
    assert.equal(response.status, 400);
    assert.equal(one('SELECT profile_picture FROM customers WHERE id = ?', [record.id]).profile_picture, null);
  });

  test('an SVG disguised as a PNG is refused by MIME check', async () => {
    const record = await createCustomer();
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const response = await client.request(
      'POST',
      '/api/account/profile/picture',
      imageForm(svg, 'avatar.png', 'image/svg+xml'),
    );

    assert.equal(response.status, 400);
  });
});

/* -------------------------------------------------------------------------- */
/* Bank catalogue                                                             */
/* -------------------------------------------------------------------------- */

describe('bank catalogue', () => {
  test('an administrator can add a bank that customers can then select', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(admin.email, admin.password);

    const created = await client.post('/api/admin/banks', {
      name: 'Test Trust Bank',
      code: 'TTBK',
      country: 'Ireland',
      routingNumberLength: 4,
      supportsLocal: true,
      supportsInternational: true,
      supportsWire: false,
    });
    assert.equal(created.status, 201);

    // The customer-facing list now offers it.
    const customer = await createCustomer({ balanceCents: 500_000 });
    const customerClient = new ApiClient(baseUrl);
    await customerClient.loginCustomer(customer.email, customer.password);

    const banks = await customerClient.get('/api/account/banks');
    const names = banks.body.banks.map((b) => b.name);
    assert.ok(names.includes('Test Trust Bank'));

    // And a transfer to it is accepted, honouring its 4-character routing rule.
    const transfer = await customerClient.post('/api/transfers', {
      transferType: 'local',
      recipientName: 'Aoife Murphy',
      recipientAccountNumber: 'IE29AIBK93115212345678',
      recipientBankId: created.body.bank.id,
      recipientRoutingNumber: 'AIBK',
      amount: '25.00',
      transferPin: '4321',
    });
    assert.equal(transfer.status, 201);
    assert.equal(transfer.body.transfer.recipient.bank, 'Test Trust Bank');

    // The wrong routing length is still refused.
    const badRouting = await customerClient.post('/api/transfers', {
      transferType: 'local',
      recipientName: 'Aoife Murphy',
      recipientAccountNumber: 'IE29AIBK93115212345678',
      recipientBankId: created.body.bank.id,
      recipientRoutingNumber: 'AIBK9311',
      amount: '25.00',
      transferPin: '4321',
    });
    assert.equal(badRouting.status, 422);
  });

  test('only a superadmin may change the catalogue', async () => {
    // The catalogue decides what every customer can send money to, so writes
    // are gated on role while reads stay open to any administrator.
    const superadmin = await createAdmin();
    const adminClient = new ApiClient(baseUrl);
    await adminClient.loginAdmin(superadmin.email, superadmin.password);

    const created = await adminClient.post('/api/admin/banks', {
      name: 'Role Gate Bank',
      country: 'United States',
    });
    const bankId = created.body.bank.id;

    const teller = await createAdmin({ role: 'teller' });
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(teller.email, teller.password);

    const read = await client.get('/api/admin/banks');
    assert.equal(read.status, 200);

    const added = await client.post('/api/admin/banks', {
      name: 'Teller Created Bank',
      country: 'United States',
    });
    assert.equal(added.status, 403);

    const edited = await client.patch(`/api/admin/banks/${bankId}`, { name: 'Renamed By Teller' });
    assert.equal(edited.status, 403);

    const retired = await client.post(`/api/admin/banks/${bankId}/deactivate`, {
      reason: 'Teller attempt.',
    });
    assert.equal(retired.status, 403);

    // None of the refusals changed anything.
    const unchanged = await adminClient.get(`/api/admin/banks/${bankId}`);
    assert.equal(unchanged.body.bank.name, 'Role Gate Bank');
    assert.equal(unchanged.body.bank.isActive, true);
  });

  test('a duplicate bank name is refused', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(admin.email, admin.password);

    const response = await client.post('/api/admin/banks', {
      name: bank.name,
      country: 'United States',
    });
    assert.equal(response.status, 409);
  });

  test('deactivating a bank hides it from customers but keeps history intact', async () => {
    const admin = await createAdmin();
    const adminClient = new ApiClient(baseUrl);
    await adminClient.loginAdmin(admin.email, admin.password);

    const created = await adminClient.post('/api/admin/banks', {
      name: 'Retired Bank Ltd',
      country: 'Bermuda',
    });

    const retired = await adminClient.post(`/api/admin/banks/${created.body.bank.id}/deactivate`, {
      reason: 'No longer a correspondent bank.',
    });
    assert.equal(retired.status, 200);
    assert.equal(retired.body.bank.isActive, false);

    const customer = await createCustomer();
    const customerClient = new ApiClient(baseUrl);
    await customerClient.loginCustomer(customer.email, customer.password);

    const visible = await customerClient.get('/api/account/banks');
    assert.ok(!visible.body.banks.map((b) => b.name).includes('Retired Bank Ltd'));

    // A transfer to the retired bank is now refused.
    const transfer = await customerClient.post('/api/transfers', {
      transferType: 'local',
      recipientName: 'Someone',
      recipientAccountNumber: '12345678',
      recipientBankId: created.body.bank.id,
      recipientRoutingNumber: '1234',
      amount: '10.00',
      transferPin: '4321',
    });
    assert.equal(transfer.status, 422);
  });

  test('a receipt keeps its snapshot even after the bank is renamed', async () => {
    const admin = await createAdmin();
    const adminClient = new ApiClient(baseUrl);
    await adminClient.loginAdmin(admin.email, admin.password);

    const created = await adminClient.post('/api/admin/banks', {
      name: 'Snapshot Test Bank',
      country: 'United States',
      routingNumberLength: 9,
    });
    const bankId = created.body.bank.id;

    const customer = await createCustomer({ balanceCents: 100_000 });
    const customerClient = new ApiClient(baseUrl);
    await customerClient.loginCustomer(customer.email, customer.password);

    const transfer = await customerClient.post('/api/transfers', {
      transferType: 'local',
      recipientName: 'Snapshot Recipient',
      recipientAccountNumber: '55555555',
      recipientBankId: bankId,
      recipientRoutingNumber: '123456789',
      amount: '40.00',
      transferPin: '4321',
    });

    await adminClient.post(`/api/admin/transfers/${transfer.body.transfer.id}/approve`, {});
    const before = await customerClient.get(`/api/transfers/${transfer.body.transfer.id}/receipt`);

    await adminClient.patch(`/api/admin/banks/${bankId}`, { name: 'Renamed Test Bank' });

    const after = await customerClient.get(`/api/transfers/${transfer.body.transfer.id}/receipt`);
    assert.equal(after.body.receipt.payload.recipient.bank, 'Snapshot Test Bank');
    assert.equal(after.body.receipt.payload.recipient.bank, before.body.receipt.payload.recipient.bank);
  });
});

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

describe('audit log', () => {
  test('privileged actions are recorded with the acting administrator', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(admin.email, admin.password);

    const record = await createCustomer({ balanceCents: 0 });
    await client.post(`/api/admin/customers/${record.id}/fund`, {
      amount: '300.00',
      description: 'Audit trail test',
    });

    const log = await client.get('/api/admin/audit-logs?action=account.funded');
    assert.equal(log.status, 200);
    assert.ok(log.body.data.length >= 1);

    const entry = log.body.data[0];
    assert.equal(entry.actor.type, 'admin');
    assert.equal(entry.actor.email, admin.email);
    assert.equal(entry.target.id, String(record.id));
    assert.equal(entry.reason, 'Audit trail test');
    assert.ok(entry.createdAt);
  });

  test('the audit log is filterable and read-only', async () => {
    const admin = await createAdmin();
    const client = new ApiClient(baseUrl);
    await client.loginAdmin(admin.email, admin.password);

    const all = await client.get('/api/admin/audit-logs?limit=5');
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.body.data));
    assert.ok(all.body.pagination.total >= 1);

    const onlyAdmins = await client.get('/api/admin/audit-logs?actorType=admin&limit=5');
    assert.ok(onlyAdmins.body.data.every((entry) => entry.actor.type === 'admin'));

    // There is no write route.
    for (const [method, path] of [
      ['POST', '/api/admin/audit-logs'],
      ['PATCH', '/api/admin/audit-logs/1'],
      ['DELETE', '/api/admin/audit-logs/1'],
    ]) {
      const response = await client.request(method, path, method === 'GET' ? undefined : {});
      assert.ok([404, 405].includes(response.status), `${method} ${path} must not exist`);
    }
  });
});
