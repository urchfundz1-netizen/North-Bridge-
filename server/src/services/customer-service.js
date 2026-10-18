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

import {
  C,
  nowIso,
  getById,
  setById,
  coll,
  snapRows,
  transaction,
  txnGetById,
  readCounter,
  bumpCounter,
  checkUnique,
  claimUnique,
  releaseUnique,
  txnSet,
  countOf,
  FieldPath,
} from '../db/firestore.js';
import { randomInt } from 'node:crypto';
import { hashSecret, verifySecret, needsRehash } from '../core/crypto.js';
import { generateUniqueAccountNumber } from '../core/identifiers.js';
import { validationFailed, conflict, notFound, badRequest } from '../core/errors.js';
import { revokeSessionsFor } from '../core/session.js';
import { postEntry, ENTRY_TYPES, listEntries, summarise } from './ledger-service.js';
import { recordAudit, AUDIT_ACTIONS } from './audit.js';

export const ACCOUNT_STATUSES = ['active', 'locked', 'frozen', 'disabled'];

const ACCOUNT_TYPES = ['checking', 'savings', 'premium'];
const LOGIN_MAX_FAILURES = 6;

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

const emailKey = (email) => `customerEmail:${String(email).trim().toLowerCase()}`;

/**
 * Create a customer account and allocate its account number.
 *
 * Password and transfer PIN are hashed independently. The account number is
 * chosen and both unique indexes are claimed inside the same transaction as the
 * insert, so neither can collide.
 */
export async function registerCustomer(input, request) {
  const email = input.email.toLowerCase();
  const now = nowIso();
  const [passwordHash, transferPinHash] = await Promise.all([
    hashSecret(input.password),
    hashSecret(input.transferPin),
  ]);

  let customerId;
  try {
    customerId = await transaction(async (txn) => {
      const id = await readCounter(txn, C.customers);
      const accountNumber = await generateUniqueAccountNumber(txn);
      await checkUnique(txn, emailKey(email), id);

      bumpCounter(txn, C.customers, id);
      claimUnique(txn, emailKey(email), id);
      claimUnique(txn, `customerAccount:${accountNumber}`, id);
      txnSet(txn, C.customers, id, {
        account_number: accountNumber,
        full_name: input.fullName,
        date_of_birth: input.dateOfBirth,
        email,
        phone: input.phone,
        address_line1: input.addressLine1,
        address_line2: input.addressLine2 ?? null,
        city: input.city,
        state_region: input.stateRegion,
        postal_code: input.postalCode,
        country: input.country ?? 'United States',
        account_type: input.accountType,
        password_hash: passwordHash,
        transfer_pin_hash: transferPinHash,
        transfer_pin_hash_updated_at: now,
        transfer_pin_failed_attempts: 0,
        transfer_pin_locked_until: null,
        failed_login_attempts: 0,
        locked_until: null,
        status: 'active',
        status_reason: null,
        status_changed_at: null,
        status_changed_by_admin_id: null,
        balance_cents: 0,
        profile_picture: null,
        last_login_at: null,
        created_at: now,
        updated_at: now,
      });
      return id;
    });
  } catch (error) {
    if (error.code === 'unique_violation' && String(error.key).startsWith('customerEmail:')) {
      throw conflict('An account already exists for that email address.');
    }
    throw error;
  }

  await recordAudit({
    actorType: 'customer',
    actorId: customerId,
    actorEmail: email,
    action: AUDIT_ACTIONS.CUSTOMER_REGISTERED,
    targetType: 'customer',
    targetId: customerId,
    targetLabel: (await getById(C.customers, customerId))?.account_number ?? null,
    metadata: { accountType: input.accountType, fullName: input.fullName },
    request,
  });

  return getById(C.customers, customerId);
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

/**
 * Verify login credentials. Returns a discriminated result rather than throwing,
 * so the caller decides how much to reveal.
 *
 * When the portal requires a second factor, the caller passes
 * `recordLogin: false`: the password is proven (and its hash upgraded if stale)
 * but `last_login_at` is left untouched until the challenge is completed, so an
 * abandoned second step never looks like a completed sign-in.
 */
export async function authenticateCustomer(email, password, { recordLogin = true } = {}) {
  const customer = await findCustomerByEmail(email);

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
    return { ok: true, customer, restricted: 'frozen' };
  }

  if (needsRehash(customer.password_hash)) {
    const upgraded = await hashSecret(password);
    await setById(C.customers, customer.id, { password_hash: upgraded }, { merge: true });
  }

  if (recordLogin) await finalizeCustomerLogin(customer.id);

  return { ok: true, customer: { ...customer, failed_login_attempts: 0 } };
}

/** Mark a fully completed sign-in (password *and* any second factor). */
export async function finalizeCustomerLogin(customerId) {
  await setById(
    C.customers,
    customerId,
    { last_login_at: nowIso(), failed_login_attempts: 0, locked_until: null },
    { merge: true },
  );
}

const LOGIN_LOCKOUT_MINUTES = 15;

async function bumpLoginFailure(customer) {
  const attempts = (customer.failed_login_attempts ?? 0) + 1;
  const shouldLock = attempts >= LOGIN_MAX_FAILURES;

  if (shouldLock) {
    const reason = 'Automatically locked after repeated failed sign-in attempts.';
    const now = nowIso();
    await setById(
      C.customers,
      customer.id,
      {
        failed_login_attempts: attempts,
        locked_until: new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60_000).toISOString(),
        status: 'locked',
        status_reason: reason,
        status_changed_at: now,
        updated_at: now,
      },
      { merge: true },
    );
    return;
  }

  await setById(
    C.customers,
    customer.id,
    { failed_login_attempts: attempts, updated_at: nowIso() },
    { merge: true },
  );
}

/* -------------------------------------------------------------------------- */
/* Self-service profile                                                       */
/* -------------------------------------------------------------------------- */

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

export async function updateOwnProfile(customerId, input, request) {
  const before = await getById(C.customers, customerId);
  if (!before) throw notFound('Account not found.');

  const patch = {};
  for (const [column, key] of SELF_EDITABLE_FIELDS) {
    if (input[key] === undefined) continue;
    patch[column] = input[key] ?? null;
  }

  if (Object.keys(patch).length === 0) return before;
  patch.updated_at = nowIso();

  await setById(C.customers, customerId, patch, { merge: true });

  const changed = SELF_EDITABLE_FIELDS.filter(
    ([column, key]) => input[key] !== undefined && (before[column] ?? null) !== (input[key] ?? null),
  ).map(([column]) => column);

  await recordAudit({
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

  return getById(C.customers, customerId);
}

/** Change the login password. Requires the current password. */
export async function changePassword(customerId, currentPassword, newPassword, request) {
  const customer = await getById(C.customers, customerId);
  if (!customer) throw notFound('Account not found.');

  const valid = await verifySecret(String(currentPassword ?? ''), customer.password_hash);
  if (!valid) throw validationFailed({ currentPassword: 'Your current password is incorrect.' });

  const newHash = await hashSecret(newPassword);
  await setById(C.customers, customerId, { password_hash: newHash, updated_at: nowIso() }, { merge: true });

  await recordAudit({
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

/** Change the transfer PIN. Requires the current password *and* the old PIN. */
export async function changeTransferPin(customerId, currentPassword, currentPin, newPin, request) {
  const customer = await getById(C.customers, customerId);
  if (!customer) throw notFound('Account not found.');

  const passwordOk = await verifySecret(String(currentPassword ?? ''), customer.password_hash);
  if (!passwordOk) throw validationFailed({ currentPassword: 'Your current password is incorrect.' });

  const pinOk = await verifySecret(String(currentPin ?? ''), customer.transfer_pin_hash);
  if (!pinOk) throw validationFailed({ currentTransferPin: 'Your current transfer PIN is incorrect.' });

  const newHash = await hashSecret(newPin);
  const now = nowIso();
  await setById(
    C.customers,
    customerId,
    { transfer_pin_hash: newHash, transfer_pin_hash_updated_at: now, updated_at: now },
    { merge: true },
  );

  await recordAudit({
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

export async function findCustomerById(id) {
  return getById(C.customers, id);
}

export async function findCustomerByAccountNumber(accountNumber) {
  const snap = await coll(C.customers)
    .where('account_number', '==', String(accountNumber ?? '').trim())
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export async function findCustomerByEmail(email) {
  const snap = await coll(C.customers)
    .where('email', '==', String(email ?? '').trim().toLowerCase())
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/** Paginated + searchable customer directory for the admin panel. */
export async function listCustomers({ search, status, accountType, limit = 25, offset = 0 } = {}) {
  if (status && status !== 'all' && !ACCOUNT_STATUSES.includes(status)) {
    throw badRequest('Unknown account status filter.');
  }
  if (accountType && accountType !== 'all' && !ACCOUNT_TYPES.includes(accountType)) {
    throw badRequest('Unknown account type filter.');
  }

  const filters = [];
  if (status && status !== 'all') filters.push(['status', status]);
  if (accountType && accountType !== 'all') filters.push(['account_type', accountType]);
  const base = filters.reduce((query, [field, value]) => query.where(field, '==', value), coll(C.customers));

  const sortRows = (rows) =>
    rows.sort((a, b) => {
      if (a.created_at === b.created_at) return b.id - a.id;
      return a.created_at < b.created_at ? 1 : -1;
    });

  // Filtered or searched views read only the matching set (equality filters
  // run server-side; substring search has no server-side form, so it scans
  // that narrowed set in JS as before).
  if (search || filters.length) {
    let rows = snapRows(await base.get());
    if (search) {
      const needle = String(search).toLowerCase();
      rows = rows.filter((row) =>
        [row.full_name, row.email, row.account_number, row.phone]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle)),
      );
    }
    sortRows(rows);
    const total = rows.length;
    return { rows: rows.slice(offset, offset + limit), total };
  }

  // Default view: read just the newest offset+limit documents instead of the
  // whole collection, with the page total from a one-read count aggregation.
  const window = snapRows(
    await coll(C.customers)
      .orderBy('created_at', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(offset + limit)
      .get(),
  );
  sortRows(window);
  const total = await countOf(coll(C.customers));
  return { rows: window.slice(offset, offset + limit), total };
}

/** Full profile view for an admin, including activity summaries. */
export async function customerDetail(id) {
  const customer = await findCustomerById(id);
  if (!customer) return null;

  const transferSnap = await coll(C.transfers).where('customer_id', '==', id).get();
  const transfers = snapRows(transferSnap)
    .sort((a, b) => (a.requested_at === b.requested_at ? b.id - a.id : a.requested_at < b.requested_at ? 1 : -1))
    .slice(0, 25)
    .map((t) => ({
      id: t.id,
      reference_number: t.reference_number,
      transfer_type: t.transfer_type,
      recipient_name: t.recipient_name,
      recipient_bank_name: t.recipient_bank_name,
      amount_cents: t.amount_cents,
      fee_cents: t.fee_cents,
      status: t.status,
      requested_at: t.requested_at,
    }));

  const ledgerSnap = await coll(C.ledger).where('customer_id', '==', id).get();
  let funding = snapRows(ledgerSnap).filter((l) => l.entry_type === 'deposit');
  funding.sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1));
  funding = funding.slice(0, 50);

  const adminIds = [...new Set(funding.map((f) => f.admin_id).filter(Boolean))];
  const admins = new Map();
  for (const adminId of adminIds) {
    const admin = await getById(C.admins, adminId);
    if (admin) admins.set(adminId, admin);
  }
  funding = funding.map((l) => ({
    id: l.id,
    amount_cents: l.amount_cents,
    balance_after_cents: l.balance_after_cents,
    description: l.description,
    reference_number: l.reference_number,
    created_at: l.created_at,
    admin_name: admins.get(l.admin_id)?.full_name ?? null,
    admin_email: admins.get(l.admin_id)?.email ?? null,
  }));

  return { customer, transfers, funding, summary: await summarise(id) };
}

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

export async function adminUpdateCustomer(id, input, admin, request) {
  const before = await findCustomerById(id);
  if (!before) throw notFound('Customer not found.');

  const patch = {};
  for (const [column, key] of ADMIN_EDITABLE) {
    if (input[key] === undefined) continue;
    patch[column] = key === 'email' ? String(input[key]).toLowerCase() : input[key] ?? null;
  }

  if (Object.keys(patch).length === 0) return before;

  const emailChanged = patch.email !== undefined && patch.email !== before.email;
  patch.updated_at = nowIso();

  const changed = ADMIN_EDITABLE.filter(([column, key]) => {
    if (input[key] === undefined) return false;
    const next = key === 'email' ? String(input[key]).toLowerCase() : input[key] ?? null;
    return (before[column] ?? null) !== next;
  }).map(([, key]) => key);

  await transaction(async (txn) => {
    const current = await txnGetById(txn, C.customers, id);
    if (!current) throw notFound('Customer not found.');

    if (emailChanged) {
      await checkUnique(txn, emailKey(patch.email), id);
      if (before.email) releaseUnique(txn, emailKey(before.email));
      claimUnique(txn, emailKey(patch.email), id);
    }

    txnSet(txn, C.customers, id, patch, { merge: true });
  }).catch((error) => {
    if (error.code === 'unique_violation') {
      throw conflict('Another account already uses that email address.');
    }
    throw error;
  });

  await recordAudit({
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
}

/**
 * Change account status. `reason` is mandatory. Disabling or locking also
 * revokes the customer's live sessions.
 */
export async function changeAccountStatus({ customerId, status, reason, admin, request }) {
  if (!ACCOUNT_STATUSES.includes(status)) {
    throw validationFailed({ status: 'Unknown account status.' });
  }
  if (!reason || !reason.trim()) {
    throw validationFailed({ reason: 'Please state the reason for this status change.' });
  }

  const customer = await findCustomerById(customerId);
  if (!customer) throw notFound('Customer not found.');
  if (customer.status === status) throw conflict(`This account is already ${status}.`);

  const previousStatus = customer.status;
  const now = nowIso();
  await setById(
    C.customers,
    customerId,
    {
      status,
      status_reason: reason.trim(),
      status_changed_at: now,
      status_changed_by_admin_id: admin.id,
      updated_at: now,
    },
    { merge: true },
  );

  if (status === 'disabled' || status === 'locked') {
    await revokeSessionsFor('customer', customerId);
  }

  await recordAudit({
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

  return findCustomerById(customerId);
}

/**
 * Credit money to a customer's account. The only path by which a balance
 * increases. Posts a signed `deposit` ledger row carrying the resulting
 * balance.
 */
export async function fundAccount({ customerId, amountCents, description, reference, admin, request }) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw validationFailed({ amount: 'Enter an amount greater than zero.' });
  }
  if (amountCents > 1_000_000_000) {
    throw validationFailed({ amount: 'Funding amount exceeds the permitted maximum.' });
  }

  const customer = await findCustomerById(customerId);
  if (!customer) throw notFound('Customer not found.');

  const result = await transaction((txn) =>
    postEntry(
      {
        customerId,
        amountCents,
        entryType: ENTRY_TYPES.DEPOSIT,
        adminId: admin.id,
        description: (description ?? '').trim() || 'Account funding',
        referenceNumber: reference ?? null,
      },
      txn,
    ),
  );

  await recordAudit({
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

  return { ...result, customer: await findCustomerById(customerId) };
}

/** Manual balance correction. Records a signed adjustment with a reason. */
export async function adjustBalance({ customerId, amountCents, reason, admin, request }) {
  if (!reason || !reason.trim()) {
    throw validationFailed({ reason: 'Please state the reason for this adjustment.' });
  }
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    throw validationFailed({ amount: 'The adjustment amount cannot be zero.' });
  }

  const customer = await findCustomerById(customerId);
  if (!customer) throw notFound('Customer not found.');

  const result = await transaction((txn) =>
    postEntry(
      {
        customerId,
        amountCents,
        entryType: ENTRY_TYPES.ADJUSTMENT,
        adminId: admin.id,
        description: reason.trim(),
      },
      txn,
    ),
  );

  await recordAudit({
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

  return { ...result, customer: await findCustomerById(customerId) };
}

/** Admin-created customer account (no self-service signup). */
export async function adminCreateCustomer(input, admin, request) {
  const generatedPin = input.transferPin ? null : String(randomInt(1000, 10_000));
  const transferPin = input.transferPin ?? generatedPin;

  const customer = await registerCustomer({ ...input, transferPin }, request);

  await recordAudit({
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
