/**
 * End-to-end lifecycle smoke test.
 *
 * Walks the real HTTP API as a browser would, through the parts the unit suite
 * cannot prove work together: admin sign-in, funding a new customer, the customer
 * quoting and submitting a transfer, an administrator approving it, and the
 * receipt appearing on both sides.
 *
 * Run against a live server:  node scripts/smoke.mjs
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000';
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? 'admin@northbridge.bank';
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? 'ChangeMe_Admin#2024';

let failures = 0;
let checks = 0;

/** Minimal cookie-aware client, mirroring the SPA. */
function createClient() {
  const cookies = new Map();
  let csrf = null;

  async function request(method, path, body, { withCsrf = true } = {}) {
    const headers = { Origin: BASE };
    if (cookies.size) {
      headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf && withCsrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
    }

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: response.status, data };
  }

  return {
    request,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b ?? {}),
    patch: (p, b) => request('PATCH', p, b),
    /** Same as `post`, but deliberately omits the CSRF header. */
    postWithoutCsrf: (p, b) => request('POST', p, b ?? {}, { withCsrf: false }),
    captureCsrf(data) {
      if (data?.csrfToken) csrf = data.csrfToken;
    },
    get csrf() {
      return csrf;
    },
  };
}

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const unique = Date.now();
const CUSTOMER = {
  fullName: 'Smoke Test User',
  dateOfBirth: '1991-04-12',
  email: `smoke-${unique}@northbridge.test`,
  phone: '+1 555 0100 999',
  addressLine1: '9 Verification Way',
  city: 'Testville',
  stateRegion: 'TS',
  postalCode: '00001',
  country: 'United States',
  accountType: 'checking',
  password: 'SmokeTestPass#2024',
  confirmPassword: 'SmokeTestPass#2024',
  transferPin: '1357',
  confirmTransferPin: '1357',
  acceptTerms: true,
};

const admin = createClient();
const customer = createClient();

console.log(`Smoke testing ${BASE}`);

/* ---------------------------------------------------------------- admin sign-in */
section('Admin session');

const adminLogin = await admin.post('/api/admin/auth/login', {
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
});
admin.captureCsrf(adminLogin.data);
check('admin can sign in', adminLogin.status === 200, adminLogin.data);
check('admin receives a CSRF token', Boolean(admin.csrf));

/* ------------------------------------------------------------------- customer */
section('Customer registration and funding');

const registration = await customer.post('/api/auth/register', CUSTOMER);
customer.captureCsrf(registration.data);
check('customer registers', registration.status === 201, registration.data);
check('registration returns a signed-in session', Boolean(registration.data?.customer));

const accountNumber = registration.data?.customer?.accountNumber;
check('an account number was issued', Boolean(accountNumber));

// The customer bank list is filtered server-side by transfer type, so this is
// exactly what the transfer form requests.
const banks = await customer.get('/api/account/banks?transferType=local');
const localBank = banks.data?.banks?.[0];
check('bank catalogue is available', Boolean(localBank), banks.data);

// Lookup resolves a partial account number to matches; it is a GET, because
// it only reads.
const lookup = await admin.get(`/api/admin/customers/lookup?accountNumber=${accountNumber}`);
const customerId = lookup.data?.matches?.[0]?.id;
check(
  'admin can look the customer up by account number',
  Boolean(customerId),
  lookup.data,
);

const deposit = await admin.post(`/api/admin/customers/${customerId}/fund`, {
  amount: '5000.00',
  description: 'Smoke test opening deposit',
  reference: 'SMOKE-1',
});
check('admin can fund the account', deposit.status === 200 || deposit.status === 201, deposit.data);

/* -------------------------------------------------------------------- transfer */
section('Transfer quote and submission');

const quotePayload = {
  transferType: 'local',
  recipientName: 'Meridian Trust Bank',
  recipientAccountNumber: '4471882201',
  recipientBankId: localBank.id,
  recipientRoutingNumber: '021000021',
  amount: '1234.56',
  description: 'Smoke test payment',
};

const quote = await customer.post('/api/transfers/quote', quotePayload);
check('customer can quote a transfer', quote.status === 200, quote.data);
check(
  'the quote prices the fee server-side',
  typeof quote.data?.quote?.feeCents === 'number',
  quote.data?.quote,
);

// The same payload with a deliberately invalid account number must be refused.
const badQuote = await customer.post('/api/transfers/quote', {
  ...quotePayload,
  recipientAccountNumber: "4471'8822",
});
check('the quote endpoint rejects malformed input', badQuote.status === 422, badQuote.data);

const wrongPin = await customer.post('/api/transfers', {
  ...quotePayload,
  transferPin: '9999',
  idempotencyKey: `smoke-wrong-${unique}`,
});
check('a wrong transfer PIN is refused', wrongPin.status === 403, wrongPin.data);

const submission = await customer.post('/api/transfers', {
  ...quotePayload,
  transferPin: CUSTOMER.transferPin,
  idempotencyKey: `smoke-${unique}`,
});
check('the transfer is accepted', submission.status === 201, submission.data);

const transferId = submission.data?.transfer?.id;
check('the transfer has an id', Boolean(transferId));
check(
  'it is awaiting approval',
  submission.data?.transfer?.status === 'pending',
  submission.data?.transfer?.status,
);

// Retrying the same idempotency key must not create a second debit.
const retry = await customer.post('/api/transfers', {
  ...quotePayload,
  transferPin: CUSTOMER.transferPin,
  idempotencyKey: `smoke-${unique}`,
});
check(
  'a retried submit returns the original transfer',
  retry.data?.transfer?.id === transferId,
  retry.data?.transfer,
);

/* --------------------------------------------------------------- immediate receipt */
section('Receipt is issued on confirmation');

/*
 * The customer confirmed their PIN, so they must already be holding a numbered
 * document. This is the behaviour that replaced "no receipt exists before
 * approval": the receipt is minted at submit time and rewritten on review.
 */
const pendingReceipt = submission.data?.receipt;
check('submit returns a receipt', Boolean(pendingReceipt), submission.data);
check(
  'the receipt is numbered at submit time',
  /^RCPT-\d{4}-[0-9A-F]{8}$/.test(pendingReceipt?.receiptNumber ?? ''),
  pendingReceipt?.receiptNumber,
);
check(
  'the receipt reads Pending',
  pendingReceipt?.payload?.transaction?.status === 'pending' &&
    pendingReceipt?.payload?.transaction?.statusLabel === 'Pending',
  pendingReceipt?.payload?.transaction,
);
check(
  'the receipt promises arrival within 24 hours',
  /within 24 hours/i.test(pendingReceipt?.payload?.transaction?.arrivalHint ?? ''),
  pendingReceipt?.payload?.transaction?.arrivalHint,
);
check(
  'the promised arrival is a real timestamp in the future',
  new Date(pendingReceipt?.payload?.transaction?.expectedArrivalBy ?? 0) >
    new Date(pendingReceipt?.payload?.transaction?.requestedAt ?? 0),
  pendingReceipt?.payload?.transaction?.expectedArrivalBy,
);
check(
  'a pending receipt does not claim money has been debited',
  pendingReceipt?.payload?.amounts?.debited === false,
  pendingReceipt?.payload?.amounts,
);
check('a pending receipt is not yet final', pendingReceipt?.payload?.transaction?.final === false);

const pendingNumber = pendingReceipt?.receiptNumber;
const pendingIssuedAt = pendingReceipt?.issuedAt;

const fetchedPending = await customer.get(`/api/transfers/${transferId}/receipt`);
check(
  'the pending receipt is served before approval',
  fetchedPending.status === 200 &&
    fetchedPending.data?.receipt?.payload?.transaction?.status === 'pending',
  fetchedPending.data,
);

/* ------------------------------------------------------------------ settlement */
section('Approval and receipt');

const approval = await admin.post(`/api/admin/transfers/${transferId}/approve`, {
  note: 'Smoke test approval',
});
check('admin can approve the transfer', approval.status === 200, approval.data);
check(
  'approval reports the settled outcome',
  Boolean(approval.data?.receipt) || approval.data?.transfer?.status === 'approved',
  approval.data,
);

// A second approval must be a no-op, not a second debit.
const doubleApproval = await admin.post(`/api/admin/transfers/${transferId}/approve`, {
  note: 'Smoke test duplicate',
});
check(
  'approving twice does not double-debit',
  doubleApproval.data?.alreadyProcessed === true,
  doubleApproval.data,
);

const receipt = await customer.get(`/api/transfers/${transferId}/receipt`);
check('the customer can now read the receipt', receipt.status === 200, receipt.data);
check(
  'the receipt carries the amount that was quoted',
  receipt.data?.receipt?.payload?.amounts?.amountCents === quote.data?.quote?.amountCents,
  receipt.data?.receipt?.payload?.amounts,
);
check(
  'the receipt carries the fee that was quoted',
  receipt.data?.receipt?.payload?.amounts?.feeCents === quote.data?.quote?.feeCents,
  receipt.data?.receipt?.payload?.amounts,
);
check(
  'the receipt total debit equals amount plus fee',
  receipt.data?.receipt?.payload?.amounts?.totalDebitCents ===
    quote.data?.quote?.amountCents + quote.data?.quote?.feeCents,
  receipt.data?.receipt?.payload?.amounts,
);

/*
 * The pending receipt and the settled one must be recognisably the same
 * document: same receipt number, same issue time. Only the outcome changes.
 */
check(
  'approval keeps the receipt number the customer already had',
  receipt.data?.receipt?.receiptNumber === pendingNumber,
  { before: pendingNumber, after: receipt.data?.receipt?.receiptNumber },
);
check(
  'approval keeps the original issue time',
  receipt.data?.receipt?.issuedAt === pendingIssuedAt,
  { before: pendingIssuedAt, after: receipt.data?.receipt?.issuedAt },
);
check(
  'the same receipt is now Approved and final',
  receipt.data?.receipt?.payload?.transaction?.status === 'approved' &&
    receipt.data?.receipt?.payload?.transaction?.statusLabel === 'Approved' &&
    receipt.data?.receipt?.payload?.transaction?.final === true,
  receipt.data?.receipt?.payload?.transaction,
);
check(
  'the settled receipt records the settlement time',
  Boolean(receipt.data?.receipt?.payload?.transaction?.settledAt),
  receipt.data?.receipt?.payload?.transaction?.settledAt,
);
check(
  'a settled receipt now records the debit',
  receipt.data?.receipt?.payload?.amounts?.debited === true,
  receipt.data?.receipt?.payload?.amounts,
);

/* ------------------------------------------------------------------ permissions */
section('Authorisation boundaries');

// Each portal's session is namespaced, so a customer cookie resolves to no admin
// session at all: 401, not 403, because no admin identity was ever presented.
const crossPortal = await customer.get('/api/admin/overview');
check(
  'a customer cannot reach the admin API',
  crossPortal.status === 401 || crossPortal.status === 403,
  crossPortal.data,
);

const adminAsCustomer = await admin.get('/api/account/summary');
check(
  'an admin cannot use the customer API',
  adminAsCustomer.status === 401 || adminAsCustomer.status === 403,
  adminAsCustomer.data,
);

// The customer's own cookie must not work against the customer API either, and
// the admin cookie must not be accepted as a customer session on a mutating call.
const forgedCustomer = await admin.patch('/api/account/profile', { fullName: 'Forged Name' });
check(
  'an admin cookie cannot edit a customer profile',
  forgedCustomer.status === 401 || forgedCustomer.status === 403,
  forgedCustomer.data,
);

// The session cookie travels, but the double-submit token does not: a cross-site
// request cannot set a custom header, so this must be refused.
const noCsrf = await admin.postWithoutCsrf(`/api/admin/transfers/${transferId}/approve`, {
  note: 'Smoke test without a CSRF token',
});
check('a mutating request without a CSRF token is refused', noCsrf.status === 403, noCsrf.data);

const adminStillIn = await admin.get('/api/admin/auth/session');
check(
  'the refused request did not end the admin session',
  adminStillIn.data?.authenticated === true,
  adminStillIn.data,
);

/* ------------------------------------------------------------------------ logout */
section('Sign-out');

const adminLogout = await admin.post('/api/admin/auth/logout');
check('admin can sign out', adminLogout.status === 200, adminLogout.data);

const adminAfterLogout = await admin.get('/api/admin/auth/session');
check(
  'the admin session is revoked after sign-out',
  adminAfterLogout.data?.authenticated === false,
  adminAfterLogout.data,
);

const customerLogout = await customer.post('/api/auth/logout');
customer.captureCsrf(customerLogout.data);
check('customer can sign out', customerLogout.status === 200, customerLogout.data);

const customerAfterLogout = await customer.get('/api/auth/session');
check(
  'the customer session is revoked after sign-out',
  customerAfterLogout.data?.authenticated === false,
  customerAfterLogout.data,
);

/* --------------------------------------------------------------------- summary */
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
