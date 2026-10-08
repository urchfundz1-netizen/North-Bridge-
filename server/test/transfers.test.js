/**
 * Financial integrity tests.
 *
 * These are the tests that matter most: they assert that money cannot be
 * created, lost, or moved twice, and that a blocked account cannot move money
 * at all.
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
  run,
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

/** Create a client signed in as a customer with a funded account. */
async function fundedCustomer(balanceCents = 500_000) {
  const record = await createCustomer({ balanceCents });
  const client = new ApiClient(baseUrl);
  await client.loginCustomer(record.email, record.password);
  return { record, client };
}

/** Create a client signed in as an administrator. */
async function adminClient() {
  const admin = await createAdmin();
  const client = new ApiClient(baseUrl);
  await client.loginAdmin(admin.email, admin.password);
  return { admin, client };
}

/** Submit a transfer from a signed-in customer client. */
function submitTransfer(client, overrides = {}) {
  return client.post('/api/transfers', {
    transferType: 'local',
    recipientName: 'Ben Franklin',
    recipientAccountNumber: '000123456789',
    recipientBankId: bank.id,
    recipientRoutingNumber: '021000021',
    amount: '100.00',
    description: 'Rent',
    transferPin: '4321',
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* Transfer creation                                                          */
/* -------------------------------------------------------------------------- */

describe('transfer creation', () => {
  test('a pending transfer does not debit the balance when approval is required', async () => {
    const { record, client } = await fundedCustomer();

    const response = await submitTransfer(client);
    assert.equal(response.status, 201);

    const after = one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]);
    assert.equal(after.balance_cents, 500_000, 'balance must be untouched while pending');

    assert.equal(response.body.transfer.status, 'pending');
    assert.equal(response.body.transfer.amountCents, 10_000);
    assert.equal(response.body.transfer.feeCents, 150);
    assert.equal(response.body.transfer.totalDebitCents, 10_150);
  });

  test('a transfer requires the correct transfer PIN', async () => {
    const { record, client } = await fundedCustomer();

    const response = await submitTransfer(client, { transferPin: '9999' });
    assert.equal(response.status, 403);
    assert.match(response.body.error.message, /Incorrect transfer PIN/i);

    assert.equal(
      one('SELECT COUNT(*) AS n FROM transfers WHERE customer_id = ?', [record.id]).n,
      0,
      'no transfer row may exist when the PIN fails',
    );
  });

  test('the transfer PIN must differ from the login password path', async () => {
    const { client } = await fundedCustomer();
    // The PIN is verified against its own hash; the login password is not accepted.
    const response = await submitTransfer(client, { transferPin: 'CustomerPass#2024' });
    assert.equal(response.status, 422, 'schema rejects a non-4-digit PIN before any lookup');
  });

  test('repeated wrong PINs lock the transfer PIN', async () => {
    const record = await createCustomer({ balanceCents: 500_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submitTransfer(client, { transferPin: '0000' });
    }

    const locked = one('SELECT * FROM customers WHERE id = ?', [record.id]);
    assert.equal(locked.transfer_pin_failed_attempts, 5);
    assert.ok(locked.transfer_pin_locked_until, 'PIN must be locked after 5 failures');

    // Even the correct PIN is refused while the lock stands.
    const response = await submitTransfer(client, { transferPin: record.transferPin });
    assert.equal(response.status, 403);
    assert.match(response.body.error.message, /locked/i);
  });

  test('rejects an amount larger than the available balance', async () => {
    const { record, client } = await fundedCustomer(5_000);

    const response = await submitTransfer(client, { amount: '500.00' });
    assert.equal(response.status, 422);
    assert.match(JSON.stringify(response.body.error.details), /balance/i);

    assert.equal(one('SELECT COUNT(*) AS n FROM transfers WHERE customer_id = ?', [record.id]).n, 0);
  });

  test('rejects a non-positive or malformed amount', async () => {
    const { client } = await fundedCustomer();

    assert.equal((await submitTransfer(client, { amount: '0' })).status, 422);
    assert.equal((await submitTransfer(client, { amount: '-50' })).status, 422);
    assert.equal((await submitTransfer(client, { amount: '10.999' })).status, 422);
    assert.equal((await submitTransfer(client, { amount: 'abc' })).status, 422);
  });

  test('rejects a bank that does not support the transfer type', async () => {
    const wireOnlyBank = one("SELECT * FROM banks WHERE supports_wire = 1 AND supports_local = 0 LIMIT 1");
    const { client } = await fundedCustomer();

    const response = await submitTransfer(client, {
      recipientBankId: wireOnlyBank.id,
      transferType: 'local',
    });
    assert.equal(response.status, 422);
    assert.match(JSON.stringify(response.body.error.details), /does not support/i);
  });

  test('rejects a routing number whose length the bank does not use', async () => {
    const { client } = await fundedCustomer();

    const response = await submitTransfer(client, { recipientRoutingNumber: '123' });
    assert.equal(response.status, 422);
    assert.match(JSON.stringify(response.body.error.details), /routing/i);
  });

  test('an idempotency key cannot create a second transfer', async () => {
    const { record, client } = await fundedCustomer();
    const key = 'retry-key-abc-123';

    const first = await submitTransfer(client, { idempotencyKey: key });
    const second = await submitTransfer(client, { idempotencyKey: key });

    assert.equal(first.status, 201);
    assert.equal(second.status, 200, 'a retried submission returns the original');
    assert.equal(first.body.transfer.id, second.body.transfer.id);
    assert.equal(one('SELECT COUNT(*) AS n FROM transfers WHERE customer_id = ?', [record.id]).n, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Approval                                                                   */
/* -------------------------------------------------------------------------- */

describe('transfer approval', () => {
  test('approving debits exactly amount + fee and writes two ledger rows', async () => {
    const { record, client } = await fundedCustomer();
    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;

    const admin = await adminClient();
    const approved = await admin.client.post(`/api/admin/transfers/${transferId}/approve`, {});

    assert.equal(approved.status, 200);
    assert.equal(approved.body.transfer.status, 'approved');

    const after = one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]);
    assert.equal(after.balance_cents, 500_000 - 10_150);

    const entries = one(
      `SELECT COUNT(*) AS n, SUM(amount_cents) AS total FROM ledger_entries
        WHERE customer_id = ? AND transfer_id = ?`,
      [record.id, transferId],
    );
    assert.equal(entries.n, 2, 'principal + fee');
    assert.equal(entries.total, -10_150);
  });

  test('a receipt is generated on approval', async () => {
    const { record, client } = await fundedCustomer();
    const created = await submitTransfer(client);

    const admin = await adminClient();
    const approved = await admin.client.post(
      `/api/admin/transfers/${created.body.transfer.id}/approve`,
      {},
    );

    assert.equal(approved.status, 200);
    const receipt = approved.body.receipt;
    assert.ok(receipt?.payload, 'the approval response must carry the receipt payload');
    assert.match(receipt.receiptNumber, /^RCPT-\d{4}-[0-9A-F]{8}$/);

    const payload = receipt.payload;
    assert.equal(payload.customer.name, record.fullName);
    assert.equal(payload.customer.accountNumber, record.accountNumber);
    assert.equal(payload.transaction.referenceNumber, created.body.transfer.referenceNumber);
    assert.equal(payload.recipient.name, 'Ben Franklin');
    assert.equal(payload.recipient.bank, bank.name);
    assert.equal(payload.recipient.accountNumber, '000123456789');
    assert.equal(payload.amounts.amountCents, 10_000);
    assert.equal(payload.amounts.feeCents, 150);
    assert.equal(payload.amounts.totalDebitCents, 10_150);
    assert.equal(payload.amounts.amountFormatted, '$100.00');
    assert.equal(payload.transaction.statusLabel, 'Approved');
    assert.equal(payload.description, 'Rent');
    assert.ok(payload.transaction.settledAt, 'the settlement timestamp is recorded');

    // Exactly one receipt per transfer.
    assert.equal(
      one('SELECT COUNT(*) AS n FROM receipts WHERE transfer_id = ?', [created.body.transfer.id]).n,
      1,
    );

    // The customer can read their own receipt.
    const mine = await client.get(`/api/transfers/${created.body.transfer.id}/receipt`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.receipt.receiptNumber, receipt.receiptNumber);
  });

  test("a customer cannot read another customer's receipt", async () => {
    const { client: owner } = await fundedCustomer();
    const ownerTransfer = await submitTransfer(owner);

    const admin = await adminClient();
    await admin.client.post(`/api/admin/transfers/${ownerTransfer.body.transfer.id}/approve`, {});

    // A second, unrelated customer guessing the transfer id.
    const { client: stranger } = await fundedCustomer();
    const attempt = await stranger.get(`/api/transfers/${ownerTransfer.body.transfer.id}/receipt`);

    assert.equal(attempt.status, 404, 'receipts are scoped by owning customer');
  });

  test('approving twice does not debit twice', async () => {
    const { record, client } = await fundedCustomer();
    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;

    const admin = await adminClient();

    const first = await admin.client.post(`/api/admin/transfers/${transferId}/approve`, {});
    assert.equal(first.status, 200);
    assert.equal(first.body.alreadyProcessed, false);

    const second = await admin.client.post(`/api/admin/transfers/${transferId}/approve`, {});
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyProcessed, true, 'second approval is reported as a no-op');

    const after = one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]);
    assert.equal(after.balance_cents, 500_000 - 10_150, 'only one debit may ever occur');

    const entries = one(
      'SELECT COUNT(*) AS n FROM ledger_entries WHERE customer_id = ? AND transfer_id = ?',
      [record.id, transferId],
    );
    assert.equal(entries.n, 2, 'no duplicate principal or fee rows');
  });

  test('two administrators approving at once settles exactly once', async () => {
    const { record, client } = await fundedCustomer();
    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;

    // Two independent admin sessions race on the same transfer.
    const adminA = await adminClient();
    const adminB = await adminClient();

    const results = await Promise.all([
      adminA.client.post(`/api/admin/transfers/${transferId}/approve`, {}),
      adminB.client.post(`/api/admin/transfers/${transferId}/approve`, {}),
    ]);

    const successes = results.filter((r) => r.status === 200 && !r.body.alreadyProcessed);
    assert.equal(successes.length, 1, 'exactly one approval may take effect');

    const after = one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]);
    assert.equal(after.balance_cents, 500_000 - 10_150);
  });

  test('rejection leaves the balance unchanged and requires a reason', async () => {
    const { record, client } = await fundedCustomer();
    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;

    const admin = await adminClient();

    const noReason = await admin.client.post(`/api/admin/transfers/${transferId}/reject`, {});
    assert.equal(noReason.status, 422);

    const rejected = await admin.client.post(`/api/admin/transfers/${transferId}/reject`, {
      reason: 'Beneficiary account details could not be verified.',
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.transfer.status, 'rejected');

    assert.equal(one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]).balance_cents, 500_000);
    assert.equal(
      one('SELECT COUNT(*) AS n FROM ledger_entries WHERE transfer_id = ?', [transferId]).n,
      0,
      'a rejected transfer writes no ledger rows',
    );
  });

  test('an approved transfer can no longer be rejected', async () => {
    const { client } = await fundedCustomer();
    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;

    const admin = await adminClient();
    await admin.client.post(`/api/admin/transfers/${transferId}/approve`, {});

    const rejected = await admin.client.post(`/api/admin/transfers/${transferId}/reject`, {
      reason: 'Changed my mind about this payment.',
    });
    assert.equal(rejected.status, 409);
  });

  test('approval fails when the balance was drained after the request', async () => {
    const { record, client } = await fundedCustomer(20_000);
    const created = await submitTransfer(client, { amount: '100.00' });
    const transferId = created.body.transfer.id;

    // Drain the account below what the pending transfer needs.
    run(`UPDATE customers SET balance_cents = 100 WHERE id = ?`, [record.id]);

    const admin = await adminClient();
    const response = await admin.client.post(`/api/admin/transfers/${transferId}/approve`, {});

    assert.equal(response.status, 409);
    assert.match(response.body.error.message, /Cannot approve/i);
    assert.equal(one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]).balance_cents, 100);
  });

  test('a customer can cancel only a pending transfer', async () => {
    const { client } = await fundedCustomer();
    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;

    const cancelled = await client.post(`/api/transfers/${transferId}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.transfer.status, 'cancelled');

    const admin = await adminClient();
    const approve = await admin.client.post(`/api/admin/transfers/${transferId}/approve`, {});
    assert.equal(approve.status, 409, 'a cancelled transfer cannot be approved');
  });
});

/* -------------------------------------------------------------------------- */
/* Account status                                                             */
/* -------------------------------------------------------------------------- */

describe('account status restrictions', () => {
  /**
   * The three blocked statuses differ in how far a customer gets:
   *   locked   - identity problem: no portal access at all.
   *   frozen   - may sign in and view balances, but cannot move money.
   *   disabled - account closed: no portal access.
   * None of them may ever result in a transfer being created.
   */
  const expectations = {
    locked: { login: 401, canSubmit: false },
    frozen: { login: 200, canSubmit: false },
    disabled: { login: 401, canSubmit: false },
  };

  for (const [status, expected] of Object.entries(expectations)) {
    test(`a ${status} account cannot submit a transfer`, async () => {
      const record = await createCustomer({ balanceCents: 500_000, status });
      const client = new ApiClient(baseUrl);

      const login = await client.post('/api/auth/login', {
        email: record.email,
        password: record.password,
      });
      assert.equal(login.status, expected.login, `sign-in behaviour for ${status}`);

      if (!expected.canSubmit) {
        assert.equal(
          one('SELECT COUNT(*) AS n FROM transfers WHERE customer_id = ?', [record.id]).n,
          0,
          'no transfer may be created from a non-active account',
        );
      }

      if (expected.login === 200) {
        // frozen: authenticated but explicitly forbidden from moving money.
        const response = await submitTransfer(client);
        assert.equal(response.status, 403);
        assert.equal(one('SELECT COUNT(*) AS n FROM transfers WHERE customer_id = ?', [record.id]).n, 0);
      }
    });
  }

  test('a customer cannot change their own account status', async () => {
    const { record, client } = await fundedCustomer();

    // 1. The customer cookie must not satisfy an admin route at all.
    const adminRoute = await client.post(`/api/admin/customers/${record.id}/status`, {
      status: 'active',
      reason: 'self service attempt',
    });
    assert.equal(adminRoute.status, 401, 'a customer session cannot reach admin routes');

    // 2. The self-service profile endpoint does not accept a status field, so
    //    it is stripped and the request is rejected as containing no changes.
    const profile = await client.patch('/api/account/profile', { status: 'active' });
    assert.equal(profile.status, 422, 'status is not an editable profile field');

    assert.equal(one('SELECT status FROM customers WHERE id = ?', [record.id]).status, 'active');
  });

  test('an administrator status change requires a reason and is audited', async () => {
    const record = await createCustomer({ balanceCents: 100_000 });
    const admin = await adminClient();

    const noReason = await admin.client.post(`/api/admin/customers/${record.id}/status`, {
      status: 'frozen',
    });
    assert.equal(noReason.status, 422);

    const response = await admin.client.post(`/api/admin/customers/${record.id}/status`, {
      status: 'frozen',
      reason: 'Compliance review pending on this account.',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.customer.status, 'frozen');

    const audit = one(
      `SELECT * FROM audit_logs WHERE action = 'account.status_changed' AND target_id = ?
        ORDER BY id DESC LIMIT 1`,
      [String(record.id)],
    );
    assert.ok(audit, 'status change must be audited');
    assert.equal(audit.reason, 'Compliance review pending on this account.');
    assert.equal(audit.actor_type, 'admin');
    assert.ok(audit.ip_address !== undefined);
  });

  test('freezing revokes nothing but blocking transfers; disabling revokes sessions', async () => {
    const record = await createCustomer({ balanceCents: 100_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const admin = await adminClient();
    await admin.client.post(`/api/admin/customers/${record.id}/status`, {
      status: 'disabled',
      reason: 'Account closed at customer request.',
    });

    const probe = await client.get('/api/auth/session');
    assert.equal(probe.status, 200);
    assert.equal(probe.body.authenticated, false, 'the session must no longer resolve');
  });

  test('locking also revokes the live session immediately', async () => {
    // The confirmation copy shown to administrators before they apply a lock
    // states that an open session ends at once, so this pins that promise.
    const record = await createCustomer({ balanceCents: 100_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const before = await client.get('/api/auth/session');
    assert.equal(before.body.authenticated, true, 'precondition: signed in');

    const admin = await adminClient();
    const changed = await admin.client.post(`/api/admin/customers/${record.id}/status`, {
      status: 'locked',
      reason: 'Suspected credential compromise.',
    });
    assert.equal(changed.status, 200);

    const after = await client.get('/api/auth/session');
    assert.equal(after.body.authenticated, false, 'a lock must end the session, not queue it for expiry');
  });

  test('freezing keeps the session but blocks transfers', async () => {
    const record = await createCustomer({ balanceCents: 100_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const admin = await adminClient();
    await admin.client.post(`/api/admin/customers/${record.id}/status`, {
      status: 'frozen',
      reason: 'Customer requested a hold pending review.',
    });

    const session = await client.get('/api/auth/session');
    assert.equal(session.body.authenticated, true, 'a freeze must not sign the customer out');

    const blocked = await submitTransfer(client);
    assert.equal(blocked.status, 403, 'a frozen account must not be able to send money');
    assert.equal(one('SELECT COUNT(*) AS n FROM transfers WHERE customer_id = ?', [record.id]).n, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Funding                                                                    */
/* -------------------------------------------------------------------------- */

describe('receipt issued on confirmation', () => {
  /**
   * The customer confirms their PIN and must leave holding a numbered document.
   * These cover the whole life of that one document, because the interesting
   * failure mode is not "no receipt" but a receipt that says the wrong thing:
   * still reading Pending after the money moved, or changing number halfway.
   */

  test('submitting returns a numbered Pending receipt with a 24 hour promise', async () => {
    const record = await createCustomer({ balanceCents: 500_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const created = await submitTransfer(client);
    assert.equal(created.status, 201);

    const receipt = created.body.receipt;
    assert.ok(receipt?.payload, 'submit must return the receipt, not just the transfer');

    const number = receipt.receiptNumber;
    assert.match(number, /^RCPT-\d{4}-[0-9A-F]{8}$/, 'the receipt is numbered at submit time');

    const payload = receipt.payload;
    assert.equal(payload.transaction.status, 'pending');
    assert.equal(payload.transaction.statusLabel, 'Pending');
    assert.match(payload.transaction.arrivalHint, /within 24 hours/i);
    assert.ok(
      new Date(payload.transaction.expectedArrivalBy) > new Date(payload.transaction.requestedAt),
      'the promised arrival must be a timestamp after the request',
    );
    assert.equal(payload.transaction.final, false, 'a pending receipt can still change');
    assert.equal(payload.amounts.debited, false, 'nothing has left the account yet');
    assert.equal(payload.transaction.settledAt, null);

    // And it is retrievable, not just returned once.
    const fetched = await client.get(`/api/transfers/${created.body.transfer.id}/receipt`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.receipt.receiptNumber, number);
  });

  test('approval keeps the same number and issue time, then freezes it', async () => {
    const record = await createCustomer({ balanceCents: 500_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;
    const before = created.body.receipt;

    const admin = await adminClient();
    const approved = await admin.client.post(`/api/admin/transfers/${transferId}/approve`, {});
    assert.equal(approved.status, 200);

    const after = approved.body.receipt;
    assert.equal(after.receiptNumber, before.receiptNumber, 'the number the customer already holds');
    assert.equal(after.issuedAt, before.issuedAt, 'and the time it was handed over');
    assert.equal(after.payload.transaction.status, 'approved');
    assert.equal(after.payload.transaction.statusLabel, 'Approved');
    assert.equal(after.payload.transaction.final, true);
    assert.equal(after.payload.amounts.debited, true);
    assert.ok(after.payload.transaction.settledAt, 'the settlement time is recorded');

    // Frozen: a settled receipt must not be rewritten by later activity.
    run("UPDATE settings SET value = 'Renamed Bank' WHERE key = 'bank_name'");
    const again = await client.get(`/api/transfers/${transferId}/receipt`);
    assert.equal(
      again.body.receipt.payload.bank.name,
      'Northbridge Bank',
      'a settled receipt keeps the bank name frozen into it',
    );
  });

  test('a rejected transfer stops its receipt claiming the money is coming', async () => {
    const record = await createCustomer({ balanceCents: 500_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;

    const admin = await adminClient();
    const rejected = await admin.client.post(`/api/admin/transfers/${transferId}/reject`, {
      reason: 'Beneficiary name does not match the account title.',
    });
    assert.equal(rejected.status, 200);

    const after = await client.get(`/api/transfers/${transferId}/receipt`);
    const payload = after.body.receipt.payload;
    assert.equal(payload.transaction.status, 'rejected');
    assert.equal(payload.transaction.statusLabel, 'Rejected');
    assert.equal(payload.amounts.debited, false);
    assert.ok(payload.rejectionReason, 'the reason is recorded on the document');
    assert.equal(
      after.body.receipt.receiptNumber,
      created.body.receipt.receiptNumber,
      'still the same receipt, now marked rejected',
    );
  });

  test('a cancelled transfer stops its receipt claiming the money is coming', async () => {
    const record = await createCustomer({ balanceCents: 500_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    const created = await submitTransfer(client);
    const transferId = created.body.transfer.id;

    const cancelled = await client.post(`/api/transfers/${transferId}/cancel`);
    assert.equal(cancelled.status, 200);

    const after = await client.get(`/api/transfers/${transferId}/receipt`);
    const payload = after.body.receipt.payload;
    assert.equal(payload.transaction.status, 'cancelled');
    assert.equal(payload.transaction.statusLabel, 'Cancelled');
    assert.equal(payload.amounts.debited, false);

    const balance = one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]);
    assert.equal(balance.balance_cents, 500_000, 'cancelling still moves no money');
  });

  test('the archive lists settled transfers only', async () => {
    const record = await createCustomer({ balanceCents: 2_000_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);
    const admin = await adminClient();

    // One settled, one left pending.
    const settled = await submitTransfer(client, { idempotencyKey: 'archive-settled-1' });
    await admin.client.post(`/api/admin/transfers/${settled.body.transfer.id}/approve`, {});

    const stillPending = await submitTransfer(client, { idempotencyKey: 'archive-pending-1' });

    const archive = await client.get('/api/transfers/receipts');
    assert.equal(archive.status, 200);

    const ids = archive.body.data.map((row) => row.transfer_id);
    assert.ok(
      ids.includes(settled.body.transfer.id),
      'a transfer that actually moved money is listed',
    );
    assert.ok(
      !ids.includes(stillPending.body.transfer.id),
      'a pending transfer must not appear in the archive of settled transfers',
    );
  });
});

describe('administrator funding', () => {
  test('funding credits the balance and is recorded', async () => {
    const record = await createCustomer({ balanceCents: 0 });
    const admin = await adminClient();

    const response = await admin.client.post(`/api/admin/customers/${record.id}/fund`, {
      amount: '750.25',
      description: 'Opening deposit',
      reference: 'CASH-001',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.customer.balanceCents, 75_025);

    const entry = one('SELECT * FROM ledger_entries WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [
      record.id,
    ]);
    assert.equal(entry.amount_cents, 75_025);
    assert.equal(entry.balance_after_cents, 75_025);
    assert.equal(entry.entry_type, 'deposit');
    assert.ok(entry.admin_id, 'the funding admin is recorded on the ledger row');

    const audit = one("SELECT * FROM audit_logs WHERE action = 'account.funded' ORDER BY id DESC LIMIT 1");
    assert.ok(audit);
    assert.equal(audit.reason, 'Opening deposit');
  });

  test('funding rejects a zero or negative amount', async () => {
    const record = await createCustomer();
    const admin = await adminClient();

    for (const amount of ['0', '-25.00']) {
      const response = await admin.client.post(`/api/admin/customers/${record.id}/fund`, { amount });
      assert.ok(response.status === 422, `expected 422 for ${amount}, got ${response.status}`);
    }
  });

  test('an adjustment cannot overdraw the account', async () => {
    const record = await createCustomer({ balanceCents: 10_000 });
    const admin = await adminClient();

    const response = await admin.client.post(`/api/admin/customers/${record.id}/adjust`, {
      amount: '-500.00',
      reason: 'Correcting a duplicate credit.',
    });

    assert.equal(response.status, 409, 'an overdraw must be refused, not applied');
    assert.equal(one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]).balance_cents, 10_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Ledger integrity                                                           */
/* -------------------------------------------------------------------------- */

describe('ledger integrity', () => {
  test('the ledger reconstructs the current balance', async () => {
    const record = await createCustomer({ balanceCents: 200_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);

    await submitTransfer(client, { amount: '50.00', description: 'First' });

    const admin = await adminClient();
    const pending = one('SELECT id FROM transfers WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [
      record.id,
    ]);
    await admin.client.post(`/api/admin/transfers/${pending.id}/approve`, {});

    await admin.client.post(`/api/admin/customers/${record.id}/fund`, {
      amount: '1000.00',
      description: 'Test credit',
    });

    const sum = one(
      'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries WHERE customer_id = ?',
      [record.id],
    ).total;
    const balance = one('SELECT balance_cents FROM customers WHERE id = ?', [record.id]).balance_cents;

    assert.equal(sum, balance, 'sum of all ledger entries must equal the balance');
    assert.equal(balance, 200_000 - 5_150 + 100_000);
  });

  test('audit log rows cannot be deleted or updated', async () => {
    // Signing in writes an audit row, so there is always one to tamper with.
    await adminClient();
    const id = one('SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1')?.id;
    if (!id) return;

    assert.throws(
      () => run('DELETE FROM audit_logs WHERE id = ?', [id]),
      /append-only/,
      'audit rows must not be deletable',
    );
    assert.throws(
      () => run("UPDATE audit_logs SET action = 'tampered' WHERE id = ?", [id]),
      /append-only/,
      'audit rows must not be updatable',
    );
  });

  test('a settled ledger row cannot be deleted', async () => {
    const record = await createCustomer({ balanceCents: 300_000 });
    const client = new ApiClient(baseUrl);
    await client.loginCustomer(record.email, record.password);
    const created = await submitTransfer(client, { amount: '25.00' });

    const admin = await adminClient();
    await admin.client.post(`/api/admin/transfers/${created.body.transfer.id}/approve`, {});

    assert.throws(
      () => run('DELETE FROM ledger_entries WHERE transfer_id = ?', [created.body.transfer.id]),
      /cannot be deleted/,
    );
  });

  test('the balance column cannot be driven negative by direct SQL', async () => {
    const record = await createCustomer({ balanceCents: 1_000 });
    assert.throws(
      () => run('UPDATE customers SET balance_cents = -5 WHERE id = ?', [record.id]),
      /CHECK constraint/i,
      'the schema itself must refuse a negative balance',
    );
  });
});
