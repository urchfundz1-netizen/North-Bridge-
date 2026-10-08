/**
 * Customer account lifecycle.
 *
 * Two clearly separated halves:
 *   * Self-service  - register, authenticate, update own profile. A customer
 *                     can never change their own `status` or `balance_cents`.
 *   * Administrative - create, edit, fund, and change status. Every one of
 *                     these writes an audit entry with the acting admin and a
 *                     mandatory reason where the action is destructive.
 */

import { one, many, run, transaction, nowIso } from '../db/connection.js';
import { randomInt } from 'node:crypto';
import { hashSecret, verifySecret, needsRehash } from '../core/crypto.js';
import { generateUniqueAccountNumber } from '../core/identifiers.js';
import { validationFailed, conflict, notFound, badRequest } from '../core/errors.js';
import { revokeSessionsFor } from '../core/session.js';
import { postEntry, ENTRY_TYPES, listEntries, summarise } from './ledger-service.js';
import { recordAudit, AUDIT_ACTIONS } from './audit.js';
import { mirrorCustomerById, mirrorLedgerEntryById } from './firestore.js';

/** Statuses an administrator may assign. */
export const ACCOUNT_STATUSES = ['active', 'locked', 'frozen', 'disabled'];

const ACCOUNT_TYPES = ['checking', 'savings', 'premium'];
const LOGIN_MAX_FAILURES = 6;

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Create a customer account and allocate its account number.
 *
 * Password and transfer PIN are hashed independently with different salts. The
 * account number is generated inside the same transaction as the insert, and
 * the UNIQUE constraint plus retry loop in `generateUniqueAccountNumber`
 * guarantees it cannot collide.
 */
export async function registerCustomer(input, request) {
  const accountNumber = generateUniqueAccountNumber();
  const [passwordHash, transferPinHash] = await Promise.all([
    hashSecret(input.password),
    hashSecret(input.transferPin),
  ]);

  let customerId;
  try {
    customerId = transaction((db) => {
      const inserted = db
        .prepare(
          `INSERT INTO customers
             (account_number, full_name, date_of_birth, email, phone,
              address_line1, address_line2, city, state_region, postal_code,
              country, account_type, password_hash, transfer_pin_hash,
              transfer_pin_hash_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          accountNumber,
          input.fullName,
          input.dateOfBirth,
          input.email.toLowerCase(),
          input.phone,
          input.addressLine1,
          input.addressLine2 ?? null,
          input.city,
          input.stateRegion,
          input.postalCode,
          input.country,
          input.accountType,
          passwordHash,
          transferPinHash,
          nowIso(),
        );
      return Number(inserted.lastInsertRowid);
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed: customers.email')) {
      throw conflict('An account already exists for that email address.');
    }
    throw error;
  }

  recordAudit({
    actorType: 'customer',
    actorId: customerId,
    actorEmail: input.email.toLowerCase(),
    action: AUDIT_ACTIONS.CUSTOMER_REGISTERED,
    targetType: 'customer',
    targetId: customerId,
    targetLabel: accountNumber,
    metadata: { accountType: input.accountType, fullName: input.fullName },
    request,
  });

  mirrorCustomerById(customerId);
  return one('SELECT * FROM customers WHERE id = ?', [customerId]);
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Verify login credentials.
 *
 * Returns a discriminated result rather than throwing, so the caller decides
 * how much to reveal. The timing-safe path always runs a hash comparison, even
 * for an unknown email, to avoid leaking which addresses are registered via
 * response time.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export async function authenticateCustomer(email, password) {
  const customer = one('SELECT * FROM customers WHERE email = ?', [String(email ?? '').toLowerCase()]);

  if (!customer) {
    await verifySecret(String(password ?? ''), DUMMY_HASH);
    return { ok: false, reason: 'invalid_credentials' };
  }

  const valid = await verifySecret(String(password ?? ''), customer.password_hash);
  if (!valid) {
    await bumpLoginFailure(customer);
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (customer.locked_until && customer.locked_until > nowIso()) {
    return { ok: false, reason: 'temporarily_locked' };
  }
  if (customer.status === 'locked') {
    return { ok: false, reason: 'locked' };
  }
  if (customer.status === 'disabled') {
    return { ok: false, reason: 'disabled' };
  }
  if (customer.status === 'frozen') {
    // Frozen accounts may still sign in to view funds, but cannot move money.
    return { ok: true, customer, restricted: 'frozen' };
  }

  run(
    'UPDATE customers SET last_login_at = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
    [nowIso(), customer.id],
  );
  mirrorCustomerById(customer.id);

  // Opportunistically upgrade hashes created under weaker parameters.
  if (needsRehash(customer.password_hash)) {
    const upgraded = await hashSecret(password);
    run('UPDATE customers SET password_hash = ? WHERE id = ?', [upgraded, customer.id]);
  }

  return { ok: true, customer: { ...customer, failed_login_attempts: 0 } };
}

const LOGIN_LOCKOUT_MINUTES = 15;

/**
 * Increment the failed sign-in counter and, on reaching the limit, lock the
 * account with an explicit reason so the audit trail explains itself.
 */
function bumpLoginFailure(customer) {
  const attempts = (customer.failed_login_attempts ?? 0) + 1;
  const shouldLock = attempts >= LOGIN_MAX_FAILURES;

  if (shouldLock) {
    const reason = 'Automatically locked after repeated failed sign-in attempts.';
    run(
      `UPDATE customers
          SET failed_login_attempts = ?, locked_until = ?, status = 'locked',
              status_reason = ?, status_changed_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        attempts,
        new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60_000).toISOString(),
        reason,
        nowIso(),
        nowIso(),
        customer.id,
      ],
    );
    mirrorCustomerById(customer.id);
    return;
  }

  run('UPDATE customers SET failed_login_attempts = ?, updated_at = ? WHERE id = ?', [
    attempts,
    nowIso(),
    customer.id,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Self-service profile                                                       */
/* -------------------------------------------------------------------------- */

/** Fields a customer is allowed to change on their own profile. */
const SELF_EDITABLE_FIELDS = [
  ['full_name', 'fullName'],
  ['phone', 'phone'],
  ['address_line1', 'addressLine1'],
  ['address_line2', 'addressLine2'],
  ['city', 'city'],
  ['state_region', 'stateRegion'],
  ['postal_code', 'postalCode'],
  ['country', 'country'],
];

export function updateOwnProfile(customerId, input, request) {
  const before = one('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!before) throw notFound('Account not found.');

  const assignments = [];
  const params = [];
  for (const [column, key] of SELF_EDITABLE_FIELDS) {
    if (input[key] === undefined) continue;
    assignments.push(`${column} = ?`);
    params.push(input[key] ?? null);
  }

  if (assignments.length === 0) return before;

  assignments.push('updated_at = ?');
  params.push(nowIso(), customerId);

  run(`UPDATE customers SET ${assignments.join(', ')} WHERE id = ?`, params);

  const changed = SELF_EDITABLE_FIELDS.filter(
    ([column, key]) => input[key] !== undefined && (before[column] ?? null) !== (input[key] ?? null),
  ).map(([column]) => column);

  recordAudit({
    actorType: 'customer',
    actorId: customerId,
    actorEmail: before.email,
    action: AUDIT_ACTIONS.CUSTOMER_PROFILE_UPDATED,
    targetType: 'customer',
    targetId: customerId,
    targetLabel: before.account_number,
    metadata: { changedFields: changed },
    request,
  });

  const updated = one('SELECT * FROM customers WHERE id = ?', [customerId]);
  mirrorCustomerById(customerId);
  return updated;
}

/** Change the login password. Requires the current password. */
export async function changePassword(customerId, currentPassword, newPassword, request) {
  const customer = one('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer) throw notFound('Account not found.');

  const valid = await verifySecret(String(currentPassword ?? ''), customer.password_hash);
  if (!valid) throw validationFailed({ currentPassword: 'Your current password is incorrect.' });

  const newHash = await hashSecret(newPassword);
  run('UPDATE customers SET password_hash = ?, updated_at = ? WHERE id = ?', [
    newHash,
    nowIso(),
    customerId,
  ]);

  recordAudit({
    actorType: 'customer',
    actorId: customerId,
    actorEmail: customer.email,
    action: AUDIT_ACTIONS.CUSTOMER_PASSWORD_CHANGED,
    targetType: 'customer',
    targetId: customerId,
    targetLabel: customer.account_number,
    request,
  });

  return true;
}

/** Change the transfer PIN. Requires the current password *and* the old PIN,
 *  so a hijacked session alone cannot take over money movement. */
export async function changeTransferPin(customerId, currentPassword, currentPin, newPin, request) {
  const customer = one('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer) throw notFound('Account not found.');

  const passwordOk = await verifySecret(String(currentPassword ?? ''), customer.password_hash);
  if (!passwordOk) throw validationFailed({ currentPassword: 'Your current password is incorrect.' });

  const pinOk = await verifySecret(String(currentPin ?? ''), customer.transfer_pin_hash);
  if (!pinOk) throw validationFailed({ currentTransferPin: 'Your current transfer PIN is incorrect.' });

  const newHash = await hashSecret(newPin);
  run(
    `UPDATE customers
        SET transfer_pin_hash = ?, transfer_pin_hash_updated_at = ?, updated_at = ?
      WHERE id = ?`,
    [newHash, nowIso(), nowIso(), customerId],
  );

  recordAudit({
    actorType: 'customer',
    actorId: customerId,
    actorEmail: customer.email,
    action: AUDIT_ACTIONS.CUSTOMER_PIN_CHANGED,
    targetType: 'customer',
    targetId: customerId,
    targetLabel: customer.account_number,
    request,
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/* Administrative operations                                                  */
/* -------------------------------------------------------------------------- */

export function findCustomerById(id) {
  return one('SELECT * FROM customers WHERE id = ?', [id]);
}

export function findCustomerByAccountNumber(accountNumber) {
  return one('SELECT * FROM customers WHERE account_number = ?', [String(accountNumber ?? '').trim()]);
}

/** Email lookup. Case-insensitive because addresses are stored lowercased. */
export function findCustomerByEmail(email) {
  return one('SELECT * FROM customers WHERE email = ?', [String(email ?? '').trim().toLowerCase()]);
}

/** Paginated + searchable customer directory for the admin panel. */
export function listCustomers({ search, status, accountType, limit = 25, offset = 0 } = {}) {
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push(
      '(full_name LIKE ? OR email LIKE ? OR account_number LIKE ? OR phone LIKE ?)',
    );
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (status && status !== 'all') {
    if (!ACCOUNT_STATUSES.includes(status)) throw badRequest('Unknown account status filter.');
    clauses.push('status = ?');
    params.push(status);
  }
  if (accountType && accountType !== 'all') {
    if (!ACCOUNT_TYPES.includes(accountType)) throw badRequest('Unknown account type filter.');
    clauses.push('account_type = ?');
    params.push(accountType);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = many(
    `SELECT * FROM customers ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const { total } = one(`SELECT COUNT(*) AS total FROM customers ${where}`, params);
  return { rows, total };
}

/** Full profile view for an admin, including activity summaries. */
export function customerDetail(id) {
  const customer = findCustomerById(id);
  if (!customer) return null;

  const transfers = many(
    `SELECT id, reference_number, transfer_type, recipient_name, recipient_bank_name,
            amount_cents, fee_cents, status, requested_at
       FROM transfers WHERE customer_id = ? ORDER BY requested_at DESC, id DESC LIMIT 25`,
    [id],
  );

  const funding = many(
    `SELECT l.id, l.amount_cents, l.balance_after_cents, l.description,
            l.reference_number, l.created_at, a.full_name AS admin_name, a.email AS admin_email
       FROM ledger_entries l
       LEFT JOIN admins a ON a.id = l.admin_id
      WHERE l.customer_id = ? AND l.entry_type = 'deposit'
      ORDER BY l.created_at DESC, l.id DESC LIMIT 50`,
    [id],
  );

  return { customer, transfers, funding, summary: summarise(id) };
}

/** Every field an admin may edit on a customer. */
const ADMIN_EDITABLE = [
  ['full_name', 'fullName'],
  ['date_of_birth', 'dateOfBirth'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['address_line1', 'addressLine1'],
  ['address_line2', 'addressLine2'],
  ['city', 'city'],
  ['state_region', 'stateRegion'],
  ['postal_code', 'postalCode'],
  ['country', 'country'],
  ['account_type', 'accountType'],
];

export function adminUpdateCustomer(id, input, admin, request) {
  const before = findCustomerById(id);
  if (!before) throw notFound('Customer not found.');

  const updated = transaction((db) => {
    const assignments = [];
    const params = [];

    for (const [column, key] of ADMIN_EDITABLE) {
      if (input[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      params.push(input[key] ?? null);
    }
    if (assignments.length === 0) return before;

    assignments.push('updated_at = ?');
    params.push(nowIso(), id);

    try {
      db.prepare(`UPDATE customers SET ${assignments.join(', ')} WHERE id = ?`).run(...params);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: customers.email')) {
        throw conflict('Another account already uses that email address.');
      }
      throw error;
    }

    const changed = ADMIN_EDITABLE.filter(
      ([column, key]) => input[key] !== undefined && (before[column] ?? null) !== (input[key] ?? null),
    ).map(([, key]) => key);

    recordAudit({
      actorType: 'admin',
      actorId: admin.id,
      actorEmail: admin.email,
      action: AUDIT_ACTIONS.ACCOUNT_UPDATED,
      targetType: 'customer',
      targetId: id,
      targetLabel: before.account_number,
      reason: input.reason ?? null,
      metadata: { changedFields: changed },
      request,
    });

    return findCustomerById(id);
  });

  // `updated === before` means no field was assigned, so nothing was written.
  if (updated !== before) mirrorCustomerById(id);
  return updated;
}

/**
 * Change account status.
 *
 * `reason` is mandatory: a compliance record without a stated cause is not
 * useful. Disabling or locking an account also revokes its live sessions, so
 * the customer is signed out immediately rather than at token expiry.
 */
export function changeAccountStatus({ customerId, status, reason, admin, request }) {
  if (!ACCOUNT_STATUSES.includes(status)) {
    throw validationFailed({ status: 'Unknown account status.' });
  }
  if (!reason || !reason.trim()) {
    throw validationFailed({ reason: 'Please state the reason for this status change.' });
  }

  const customer = findCustomerById(customerId);
  if (!customer) throw notFound('Customer not found.');

  if (customer.status === status) {
    throw conflict(`This account is already ${status}.`);
  }

  const previousStatus = customer.status;

  const updated = transaction((db) => {
    db.prepare(
      `UPDATE customers
          SET status = ?, status_reason = ?, status_changed_at = ?,
              status_changed_by_admin_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(status, reason.trim(), nowIso(), admin.id, nowIso(), customerId);
    return findCustomerById(customerId);
  });

  // A blocked account should not keep an authenticated session alive.
  if (status === 'disabled' || status === 'locked') {
    revokeSessionsFor('customer', customerId);
  }

  recordAudit({
    actorType: 'admin',
    actorId: admin.id,
    actorEmail: admin.email,
    action: AUDIT_ACTIONS.ACCOUNT_STATUS_CHANGED,
    targetType: 'customer',
    targetId: customerId,
    targetLabel: customer.account_number,
    reason: reason.trim(),
    metadata: { from: previousStatus, to: status, customerName: customer.full_name },
    request,
  });

  mirrorCustomerById(customerId);
  return updated;
}

/**
 * Credit money to a customer's account.
 *
 * This is the only path by which a balance increases. It posts a signed
 * `deposit` ledger row carrying the resulting balance, so funding history and
 * transaction history are the same auditable record.
 */
export function fundAccount({ customerId, amountCents, description, reference, admin, request }) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw validationFailed({ amount: 'Enter an amount greater than zero.' });
  }
  if (amountCents > 1_000_000_000) {
    throw validationFailed({ amount: 'Funding amount exceeds the permitted maximum.' });
  }

  const customer = findCustomerById(customerId);
  if (!customer) throw notFound('Customer not found.');

  const result = transaction(() => {
    const posted = postEntry({
      customerId,
      amountCents,
      entryType: ENTRY_TYPES.DEPOSIT,
      adminId: admin.id,
      description: (description ?? '').trim() || 'Account funding',
      referenceNumber: reference ?? null,
    });
    return posted;
  });

  recordAudit({
    actorType: 'admin',
    actorId: admin.id,
    actorEmail: admin.email,
    action: AUDIT_ACTIONS.ACCOUNT_FUNDED,
    targetType: 'customer',
    targetId: customerId,
    targetLabel: customer.account_number,
    reason: (description ?? '').trim() || null,
    metadata: {
      amountCents,
      balanceBeforeCents: result.balanceAfterCents - amountCents,
      balanceAfterCents: result.balanceAfterCents,
      reference: reference ?? null,
    },
    request,
  });

  mirrorCustomerById(customerId);
  mirrorLedgerEntryById(result.entryId);

  return { ...result, customer: findCustomerById(customerId) };
}

/** Manual balance correction. Records a signed adjustment with a reason. */
export function adjustBalance({ customerId, amountCents, reason, admin, request }) {
  if (!reason || !reason.trim()) {
    throw validationFailed({ reason: 'Please state the reason for this adjustment.' });
  }
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    throw validationFailed({ amount: 'The adjustment amount cannot be zero.' });
  }

  const customer = findCustomerById(customerId);
  if (!customer) throw notFound('Customer not found.');

  const result = transaction(() =>
    postEntry({
      customerId,
      amountCents,
      entryType: ENTRY_TYPES.ADJUSTMENT,
      adminId: admin.id,
      description: reason.trim(),
    }),
  );

  recordAudit({
    actorType: 'admin',
    actorId: admin.id,
    actorEmail: admin.email,
    action: AUDIT_ACTIONS.BALANCE_ADJUSTED,
    targetType: 'customer',
    targetId: customerId,
    targetLabel: customer.account_number,
    reason: reason.trim(),
    metadata: {
      deltaCents: amountCents,
      balanceBeforeCents: result.balanceAfterCents - amountCents,
      balanceAfterCents: result.balanceAfterCents,
    },
    request,
  });

  mirrorCustomerById(customerId);
  mirrorLedgerEntryById(result.entryId);

  return { ...result, customer: findCustomerById(customerId) };
}

/** Admin-created customer account (no self-service signup). */
export async function adminCreateCustomer(input, admin, request) {
  // When the admin does not choose a PIN, generate one from the CSPRNG and
  // return it so it can be communicated out-of-band.
  const generatedPin = input.transferPin ? null : String(randomInt(1000, 10_000));
  const transferPin = input.transferPin ?? generatedPin;

  const customer = await registerCustomer({ ...input, transferPin }, request);

  recordAudit({
    actorType: 'admin',
    actorId: admin.id,
    actorEmail: admin.email,
    action: AUDIT_ACTIONS.ACCOUNT_CREATED,
    targetType: 'customer',
    targetId: customer.id,
    targetLabel: customer.account_number,
    reason: input.reason ?? null,
    metadata: {
      fullName: customer.full_name,
      email: customer.email,
      transferPinGenerated: Boolean(generatedPin),
    },
    request,
  });

  return { customer, generatedTransferPin: generatedPin };
}

export { listEntries, summarise, ACCOUNT_TYPES };