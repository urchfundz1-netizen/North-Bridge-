/**
 * Typed access to environment configuration.
 *
 * All environment variables are read and validated exactly once, at import
 * time, so a misconfigured deployment fails immediately and loudly instead of
 * silently falling back to an insecure default at request time.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, '..', '..');
export const REPO_ROOT = resolve(SERVER_ROOT, '..');

/** Minimal .env loader - avoids a dependency for ~20 lines of work. */
function loadEnvFile() {
  const envPath = resolve(REPO_ROOT, '.env');
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables always win over the .env file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

function str(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return fallback;
  }
  return value;
}

function int(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function bool(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const NODE_ENV = str('NODE_ENV', 'development');
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test' || process.env.NB_TEST === '1';

const sessionSecret = str('SESSION_SECRET');

if (isProduction && sessionSecret.startsWith('dev-only')) {
  throw new Error(
    'SESSION_SECRET still holds the example value. Generate a real secret before running in production.',
  );
}

const cookieSecure = bool('COOKIE_SECURE', isProduction);

/*
 * Cross-site deployments (client on Vercel, API on Cloud Functions) need
 * `SameSite=None` or the browser withholds the session cookie entirely -
 * login would appear to succeed and then every page would be signed out.
 * `None` is only accepted by browsers over HTTPS with `Secure`, so the
 * combination is validated here rather than discovered in production.
 */
const cookieSameSite = str('COOKIE_SAMESITE', 'strict').toLowerCase();

if (!['strict', 'lax', 'none'].includes(cookieSameSite)) {
  throw new Error(`COOKIE_SAMESITE must be one of strict, lax or none - got "${cookieSameSite}".`);
}

if (cookieSameSite === 'none' && !cookieSecure) {
  throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=1; browsers reject insecure SameSite=None cookies.');
}

const rawClientOrigin = str('CLIENT_ORIGIN');
const clientOrigin = rawClientOrigin || 'http://localhost:5173';

/* --------------------------------------------------------------------------
 * Firebase project configuration.
 *
 * Firestore is the database and Cloud Storage holds customer avatars.
 * Credentials come from the runtime (Cloud Functions) or Application Default
 * Credentials (local / VPS). When a service-account key is present in the
 * environment (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, as shipped in the
 * .env template for local runs against the real project), it is used instead
 * of ADC. Storage rules deny all client writes (see storage.rules).
 * ------------------------------------------------------------------------ */
const firebase = {
  projectId: str('FIREBASE_PROJECT_ID', ''),
  clientEmail: str('FIREBASE_CLIENT_EMAIL', ''),
  privateKey: str('FIREBASE_PRIVATE_KEY', ''),
  // Empty means "use the project's default bucket" (<project>.appspot.com).
  storageBucket: str('FIREBASE_STORAGE_BUCKET', ''),
};

// Google's service-account JSON replaces literal "\n" escapes in the private
// key, so normalise them back to real newlines before handing it to cert().
if (firebase.privateKey) firebase.privateKey = firebase.privateKey.replace(/\\n/g, '\n');

/*
 * Same reasoning as SESSION_SECRET, and it bites harder here because the value
 * left behind is *correct-looking* rather than an obvious placeholder. Deploy
 * with the .env copied from .env.example and the server never complains - it
 * just answers every response with
 *   Access-Control-Allow-Origin: http://localhost:5173
 * and the real browser quietly refuses the API. The symptom is a page that
 * loads and then cannot sign in, with nothing wrong in the server logs.
 *
 * Checking the resolved value rather than "was it set" is deliberate: unset
 * resolves to the loopback default anyway, and an operator who sets localhost
 * on purpose should reach for ALLOW_LOOPBACK_ORIGIN rather than have the guard
 * quietly treat intent and accident as different cases.
 */
const loopbackOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(clientOrigin);

if (isProduction && loopbackOrigin && !bool('ALLOW_LOOPBACK_ORIGIN')) {
  throw new Error(
    `CLIENT_ORIGIN is a loopback address (${clientOrigin}), which no remote browser can reach. ` +
      'Set it to the public https origin of the app. If the API also serves the built client, set it ' +
      'to that origin so CORS stays same-origin. Set ALLOW_LOOPBACK_ORIGIN=1 to override deliberately.',
  );
}

export const config = {
  env: NODE_ENV,
  isProduction,
  isTest,

  port: int('PORT', 4000),
  clientOrigin,

  sessionSecret,
  sessionTtlHours: int('SESSION_TTL_HOURS', 12),
  adminSessionTtlHours: int('ADMIN_SESSION_TTL_HOURS', 8),
  cookieSecure,
  cookieSameSite,

  firebase,

  banking: {
    requireTransferApproval: bool('REQUIRE_TRANSFER_APPROVAL', true),
    transferFeeCents: int('TRANSFER_FEE_CENTS', 150),
    minTransferCents: int('MIN_TRANSFER_CENTS', 100),
    maxTransferCents: int('MAX_TRANSFER_CENTS', 50_000_000),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 2 * 1024 * 1024),
  },

  admin: {
    email: str('ADMIN_EMAIL', ''),
    password: str('ADMIN_PASSWORD', ''),
    fullName: str('ADMIN_FULL_NAME', 'System Administrator'),
  },
};

/** Cookie names are namespaced so the two portals cannot share a session. */
export const COOKIE_NAMES = {
  customer: 'nb_customer_session',
  admin: 'nb_admin_session',
};