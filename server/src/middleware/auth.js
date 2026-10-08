/**
 * Authentication, authorisation and CSRF middleware.
 *
 * Role separation is enforced twice:
 *   1. In the cookie namespace - customers and admins hold different cookies.
 *   2. In SQL - a session lookup is constrained by `actor_type`, so an admin
 *      cookie can never resolve to a customer session even if a client sends
 *      it to a customer endpoint.
 *
 * Combined with separate tables (`customers` / `admins`) and separate password
 * columns, there is no path by which customer credentials grant admin rights.
 */

import { one } from '../db/connection.js';
import { resolveSession, cookieNameFor } from '../core/session.js';
import { unauthorized, forbidden } from '../core/errors.js';

/** Read the session cookie for an actor type. */
function tokenFor(req, actorType) {
  return req.cookies?.[cookieNameFor(actorType)] ?? null;
}

/** Load the customer/admins row for a session, or null. */
function loadActor(session) {
  if (session.actor_type === 'customer') {
    const customer = one('SELECT * FROM customers WHERE id = ?', [session.actor_id]);
    if (customer) return customer;
  } else {
    const admin = one('SELECT * FROM admins WHERE id = ?', [session.actor_id]);
    if (admin) return admin;
  }
  return null;
}

/**
 * Populate `req.auth` when a valid session exists, but never reject.
 * Used by endpoints that change behaviour for signed-in users.
 */
export function attachAuth(actorType) {
  return (req, _res, next) => {
    const session = resolveSession(tokenFor(req, actorType), actorType);
    if (session) {
      const actor = loadActor(session);
      // A session whose actor row was deleted or disabled is treated as no session.
      if (actor && (actorType !== 'admin' || actor.status === 'active')) {
        req.auth = {
          session,
          actor,
          actorId: actor.id,
          actorType,
          csrfToken: session.csrf_token,
          isAdmin: actorType === 'admin',
        };
      } else {
        req.auth = null;
      }
    }
    next();
  };
}

/** Require a signed-in customer. Does not check account status. */
export function requireCustomer(req, _res, next) {
  if (!req.auth) return next(unauthorized('Please sign in to your Northbridge account.'));
  next();
}

/** Require a signed-in administrator. */
export function requireAdmin(req, _res, next) {
  if (!req.auth) return next(unauthorized('Administrator sign-in required.'));
  if (req.auth.actor.status !== 'active') {
    return next(forbidden('This administrator account has been disabled.'));
  }
  next();
}

/**
 * Account statuses that permit money movement.
 * `locked`  - authentication/identity issue; all access suspended.
 * `frozen`  - account usable for viewing but outbound transfers are blocked.
 * `disabled`- closed entirely; no portal access.
 */
export const TRANSFER_BLOCKING_STATUSES = new Set(['locked', 'frozen', 'disabled']);

/** Guard any action that moves money out of an account. */
export function requireActiveForTransfers(req, _res, next) {
  if (!req.auth) return next(unauthorized());
  const { status } = req.auth.actor;
  if (status !== 'active') {
    const messages = {
      locked: 'Your account is locked. Please contact Northbridge support.',
      frozen: 'Your account is frozen. Outgoing transfers are temporarily unavailable.',
      disabled: 'Your account has been disabled. Please contact Northbridge support.',
    };
    return next(forbidden(messages[status] ?? 'This account cannot make transfers.'));
  }
  next();
}

/**
 * Block any portal access for non-active accounts. Applied to customer routes
 * that are not "contact support" style.
 */
export function requireUsableAccount(req, _res, next) {
  if (!req.auth) return next(unauthorized());
  if (req.auth.actor.status === 'disabled') {
    return next(forbidden('Your account has been disabled. Please contact Northbridge support.'));
  }
  next();
}

/**
 * CSRF: double-submit token verification.
 *
 * Every state-changing request must echo the session's CSRF token in the
 * `X-CSRF-Token` header. A cross-site form or `fetch` cannot read that header
 * value, and the cookie is `SameSite=Strict`, so the two together block CSRF.
 * Comparison is constant-time.
 */
export function requireCsrf(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.auth) return next(unauthorized());

  const sent = req.get('x-csrf-token') ?? '';
  const expected = req.auth.csrfToken ?? '';
  if (!sent || !expected || !constantTimeEquals(sent, expected)) {
    return next(forbidden('Your session token is stale. Please refresh the page and try again.'));
  }
  next();
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Role gate for admin-only sub-actions, e.g. only `superadmin` may manage banks. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.actor.role)) {
      return next(forbidden('Your administrator role does not permit this action.'));
    }
    next();
  };
}