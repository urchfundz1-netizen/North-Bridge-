/**
 * Schema normalisation and system-settings tests.
 *
 * These cover the two classes of bug that a passing happy-path suite misses:
 *
 *   1. Input normalisation. Bank identifiers are written with spaces and hyphens
 *      for legibility, so the schemas and the service have to agree on what
 *      "the same" IBAN looks like. If they disagree, a customer who types an IBAN
 *      correctly and in the conventional format gets rejected.
 *   2. Audit completeness. Every privileged write must leave a searchable trail;
 *      an action name that is referenced but never defined records a null action
 *      and is invisible when filtering the log.
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

describe('bank identifier normalisation', () => {
  test('accepts an IBAN written in groups of four and stores it unbroken', async () => {
    const client = new ApiClient(baseUrl);
    const customer = await createCustomer({ balanceCents: 500_000 });
    await client.loginCustomer(customer.email, customer.password);

    const spaced = 'AU29 1234 5678 9012 3456 78';
    const response = await client.post('/api/transfers/quote', {
      transferType: 'international',
      recipientName: 'Aurora Pacific Bank',
      recipientAccountNumber: '9930447122',
      recipientBankId: bank.id,
      recipientIban: spaced,
      recipientSwiftBic: 'AUPBAU2X',
      recipientCountry: 'Australia',
      amount: '50.00',
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.quote, 'a quote should be returned');

    // Submitting it must also succeed, and the stored value must be canonical so
    // the receipt matches what the destination bank expects.
    const created = await client.post('/api/transfers', {
      transferType: 'international',
      recipientName: 'Aurora Pacific Bank',
      recipientAccountNumber: '9930447122',
      recipientBankId: bank.id,
      recipientIban: spaced,
      recipientSwiftBic: 'AUPBAU2X',
      recipientCountry: 'Australia',
      amount: '50.00',
      transferPin: customer.transferPin,
      idempotencyKey: `norm-${Date.now()}-iban`,
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(
      created.body.transfer.recipient.iban,
      spaced.replace(/\s/g, ''),
      'the stored IBAN should have no separators',
    );
  });

  test('accepts a routing number typed with spaces', async () => {
    const client = new ApiClient(baseUrl);
    const customer = await createCustomer({ balanceCents: 500_000 });
    await client.loginCustomer(customer.email, customer.password);

    const response = await client.post('/api/transfers/quote', {
      transferType: 'local',
      recipientName: 'Meridian Trust Bank',
      recipientAccountNumber: '4471 8822 01',
      recipientBankId: bank.id,
      recipientRoutingNumber: bank.routing_number_length === 9 ? '021 000 021' : '021000',
      amount: '40.00',
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
  });

  test('still rejects characters that are not valid in an account number', async () => {
    const client = new ApiClient(baseUrl);
    const customer = await createCustomer({ balanceCents: 500_000 });
    await client.loginCustomer(customer.email, customer.password);

    const routing =
      bank.routing_number_length === 9 ? '021000021' : '021000021';

    const response = await client.post('/api/transfers/quote', {
      transferType: 'local',
      recipientName: 'Meridian Trust Bank',
      // An apostrophe is not a valid account-number character.
      recipientAccountNumber: "4471'8822",
      recipientBankId: bank.id,
      recipientRoutingNumber: routing,
      amount: '40.00',
    });

    // Rejected by the request schema, which answers 422.
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.ok(
      response.body.error?.details?.recipientAccountNumber ??
        response.body.details?.recipientAccountNumber,
      `should name the offending field: ${JSON.stringify(response.body)}`,
    );
  });
});

describe('settings changes are audited', () => {
  test('every mutable setting records a named action with before and after', async () => {
    const client = new ApiClient(baseUrl);
    const admin = await createAdmin({ role: 'superadmin' });
    await client.loginAdmin(admin.email, admin.password);

    const before = client
      ? one('SELECT value FROM settings WHERE key = ?', ['transfer_fee_cents'])
      : null;

    const response = await client.patch('/api/admin/settings', {
      key: 'transfer_fee_cents',
      value: '275',
      reason: 'Regression test',
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.rules.transferFeeCents, 275);

    const entry = one(
      "SELECT * FROM audit_logs WHERE action = 'setting.updated' AND target_id = 'transfer_fee_cents' ORDER BY id DESC LIMIT 1",
    );

    assert.ok(entry, 'a setting.updated audit entry should exist');
    assert.ok(entry.action, 'the action name must not be null');
    assert.equal(entry.actor_email, admin.email);
    assert.equal(entry.reason, 'Regression test');

    // Read it back through the API's own serializer, so this asserts what an
    // administrator sees in the audit log rather than the raw column layout.
    const logs = await client.get(
      '/api/admin/audit-logs?action=setting.updated&limit=10',
    );
    assert.equal(logs.status, 200, JSON.stringify(logs.body));

    const seen = logs.body.data?.find(
      (row) => row.target?.id === 'transfer_fee_cents' && row.reason === 'Regression test',
    );

    assert.ok(seen, 'the change should be visible in the audit log');
    assert.equal(seen.metadata?.after, '275');
    assert.equal(String(seen.metadata?.before), String(before?.value));

    // Restore, so the suite does not leak its fee change into other tests.
    await client.patch('/api/admin/settings', { key: 'transfer_fee_cents', value: '150' });
  });

  test('refuses to change a setting outside the allow-list', async () => {
    const client = new ApiClient(baseUrl);
    const admin = await createAdmin({ role: 'superadmin' });
    await client.loginAdmin(admin.email, admin.password);

    const response = await client.patch('/api/admin/settings', {
      key: 'support_email',
      value: 'attacker@example.com',
    });

    assert.equal(response.status, 422, JSON.stringify(response.body));
    // The rejection is reported against the `key` field, so assert there rather
    // than on the generic headline.
    assert.match(response.body.error?.details?.key ?? '', /cannot be changed/i);
  });

  test('administrator bootstrap actions use canonical audit action names', async () => {
    // `seedAdmin` records these by name, so they belong in the canonical list
    // alongside every other action. Otherwise they cannot be filtered for.
    const { AUDIT_ACTIONS } = await import('../src/services/audit.js');
    assert.equal(AUDIT_ACTIONS.ADMIN_CREATED, 'admin.created');
    assert.equal(AUDIT_ACTIONS.ADMIN_PASSWORD_ROTATED, 'admin.password_rotated');
  });
});
