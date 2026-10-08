/**
 * API client.
 *
 * Every request goes through here so three concerns are handled in one place:
 *
 *   1. Credentials - the session cookie is `httpOnly`, so the browser sends it
 *      automatically and JavaScript never sees it. Nothing sensitive is stored
 *      in localStorage.
 *   2. CSRF - the token handed out with the session is echoed in a header on
 *      every state-changing request.
 *   3. Errors - non-2xx responses become an `ApiError` carrying the server's
 *      machine-readable code and field-level validation details.
 *
 * Base URL: in development Vite proxies /api to the Express server so the
 * browser sees a single origin. In production the API serves the built client
 * from that same origin.
 *
 * Money contract
 *   Responses are always integer cents (`amountCents`); requests send a decimal
 *   string (`amount: "1250.00"`) because that is what the server's validation
 *   schema parses. `parseAmount` below is the single place that converts between
 *   the two for local comparisons.
 */

const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

let csrfToken = null;

/** Adopt the CSRF token issued with the current session. */
export function setCsrfToken(token) {
  csrfToken = token ?? null;
}

export function getCsrfToken() {
  return csrfToken;
}

export class ApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }

  /** Field name -> message, for rendering inline form errors. */
  get fieldErrors() {
    return this.details && typeof this.details === 'object' && !Array.isArray(this.details)
      ? this.details
      : null;
  }

  get isAuthError() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }

  get isConflict() {
    return this.status === 409;
  }

  /** Offline / DNS / connection reset. */
  get isNetworkError() {
    return this.status === 0;
  }
}

async function request(method, path, { body, signal, headers: extraHeaders } = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  let payload;
  if (body instanceof FormData) {
    // Let the browser set the multipart boundary.
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  if (isMutation && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'Unable to reach Northbridge Bank. Check your connection and try again.',
    });
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError({
      status: response.status,
      code: error.code ?? 'unknown_error',
      message: error.message ?? `Request failed (${response.status}).`,
      details: error.details,
    });
  }

  if (data?.csrfToken) setCsrfToken(data.csrfToken);
  return data;
}

const http = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  delete: (path, body, options) => request('DELETE', path, { ...options, body }),
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The server returns `{ data, pagination: { total, limit, offset, hasMore } }`.
 * Every list screen wants a page-based model instead, so the offset is
 * converted to a 1-based page here rather than in each page component.
 */
function paginated(response) {
  const pagination = response?.pagination ?? {};
  const limit = pagination.limit ?? 20;
  const offset = pagination.offset ?? 0;
  const total = pagination.total ?? 0;
  const items = response?.data ?? [];
  return {
    items,
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: pagination.hasMore ?? offset + items.length < total,
  };
}

/** Build a query string, omitting empty values so URLs stay tidy. */
export function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }
  const string = search.toString();
  return string ? `?${string}` : '';
}

/** Offsets for a given 1-based page and page size. */
export function pageParams(page, limit) {
  return { limit, offset: (Math.max(1, page) - 1) * limit };
}

/**
 * Validate a user-typed amount locally and expose it as both the decimal string
 * the API expects and integer cents for client-side comparisons.
 * Returns `null` when the input cannot be a positive 2-decimal amount.
 */
export function parseAmount(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!raw || !/^\d{1,12}(\.\d{0,2})?$/.test(raw)) return null;
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return { cents, value: raw };
}

/** Signed variant for administrator balance adjustments ("-250.00"). */
export function parseSignedAmount(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!raw || !/^[+-]?\d{1,12}(\.\d{0,2})?$/.test(raw)) return null;
  const cents = Math.round(Number(raw) * 100);
  if (cents === 0 || !Number.isSafeInteger(cents)) return null;
  return { cents, value: raw };
}

/* -------------------------------------------------------------------------- */
/* Customer API                                                               */
/* -------------------------------------------------------------------------- */

export const customerApi = {
  session: () => http.get('/api/auth/session'),
  register: (payload) => http.post('/api/auth/register', payload),
  login: (email, password) => http.post('/api/auth/login', { email, password }),
  logout: () => http.post('/api/auth/logout', {}),
  changePassword: (payload) => http.post('/api/auth/change-password', payload),
  changeTransferPin: (payload) => http.post('/api/auth/change-transfer-pin', payload),

  profile: () => http.get('/api/account/profile'),
  updateProfile: (payload) => http.patch('/api/account/profile', payload),
  uploadPicture: (file) => {
    const form = new FormData();
    form.append('picture', file);
    return http.post('/api/account/profile/picture', form);
  },

  summary: () => http.get('/api/account/summary'),
  transactions: async (params) => paginated(await http.get(`/api/account/transactions${qs(params)}`)),
  banks: (params) => http.get(`/api/account/banks${qs(params)}`),

  quoteTransfer: (payload) => http.post('/api/transfers/quote', payload),
  createTransfer: (payload) => http.post('/api/transfers', payload),
  transfers: async (params) => paginated(await http.get(`/api/transfers${qs(params)}`)),
  transfer: (id) => http.get(`/api/transfers/${id}`),
  cancelTransfer: (id) => http.post(`/api/transfers/${id}/cancel`, {}),
  receipt: (transferId) => http.get(`/api/transfers/${transferId}/receipt`),
  receipts: async (params) => paginated(await http.get(`/api/transfers/receipts${qs(params)}`)),
};

/* -------------------------------------------------------------------------- */
/* Admin API                                                                  */
/* -------------------------------------------------------------------------- */

export const adminApi = {
  session: () => http.get('/api/admin/auth/session'),
  login: (email, password) => http.post('/api/admin/auth/login', { email, password }),
  logout: () => http.post('/api/admin/auth/logout', {}),
  changePassword: (payload) => http.post('/api/admin/auth/change-password', payload),

  overview: () => http.get('/api/admin/overview'),

  customers: async (params) => paginated(await http.get(`/api/admin/customers${qs(params)}`)),
  customer: (id) => http.get(`/api/admin/customers/${id}`),
  customerTransactions: async (id, params) =>
    paginated(await http.get(`/api/admin/customers/${id}/transactions${qs(params)}`)),
  lookup: (accountNumber) => http.get(`/api/admin/customers/lookup${qs({ accountNumber })}`),
  createCustomer: (payload) => http.post('/api/admin/customers', payload),
  updateCustomer: (id, payload) => http.patch(`/api/admin/customers/${id}`, payload),
  setStatus: (id, status, reason) => http.post(`/api/admin/customers/${id}/status`, { status, reason }),
  fundAccount: (id, payload) => http.post(`/api/admin/customers/${id}/fund`, payload),
  adjustBalance: (id, payload) => http.post(`/api/admin/customers/${id}/adjust`, payload),
  uploadPicture: (id, file) => {
    const form = new FormData();
    form.append('picture', file);
    return http.post(`/api/admin/customers/${id}/picture`, form);
  },

  transfers: async (params) => paginated(await http.get(`/api/admin/transfers${qs(params)}`)),
  transfer: (id) => http.get(`/api/admin/transfers/${id}`),
  transferStats: () => http.get('/api/admin/transfers/stats'),
  approveTransfer: (id, note) => http.post(`/api/admin/transfers/${id}/approve`, { note }),
  rejectTransfer: (id, reason) => http.post(`/api/admin/transfers/${id}/reject`, { reason }),
  transferReceipt: (id) => http.get(`/api/admin/transfers/${id}/receipt`),

  banks: (params) => http.get(`/api/admin/banks${qs(params)}`),
  createBank: (payload) => http.post('/api/admin/banks', payload),
  updateBank: (id, payload) => http.patch(`/api/admin/banks/${id}`, payload),
  deactivateBank: (id, reason) => http.post(`/api/admin/banks/${id}/deactivate`, { reason }),

  auditLogs: async (params) => paginated(await http.get(`/api/admin/audit-logs${qs(params)}`)),
  auditActions: () => http.get('/api/admin/audit-logs/actions'),
  settings: () => http.get('/api/admin/settings'),
  updateSetting: (key, value, reason) => http.patch('/api/admin/settings', { key, value, reason }),
};