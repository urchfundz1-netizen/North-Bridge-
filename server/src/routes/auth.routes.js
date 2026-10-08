/**
 * Customer authentication routes.
 *
 * Mounted at /api/auth. Sign-in issues an httpOnly session cookie; no token is
 * ever exposed to JavaScript, and nothing about the account is trusted from the
 * client after this point - every subsequent request re-reads the account from
 * the database via the session.
 */

import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { throttle, clearThrottle, recordThrottleFailure } from '../middleware/throttle.js';
import { attachAuth, requireCustomer, requireCsrf } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error-handler.js';
import {
  customerLoginSchema,
  registerSchema,
  changePasswordSchema,
  changePinSchema,
} from './schemas.js';
import { toCustomerSelf } from './serializers.js';
import {
  registerCustomer,
  authenticateCustomer,
  changePassword,
  changeTransferPin,
} from '../services/customer-service.js';
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  cookieNameFor,
} from '../core/session.js';
import { bankingRules } from '../services/settings.js';
import { recordAudit, AUDIT_ACTIONS } from '../services/audit.js';
import { unauthorized } from '../core/errors.js';

const router = Router();

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60_000;

/** Human-readable reason per authentication outcome. */
const LOGIN_MESSAGES = {
  invalid_credentials: 'We could not match that email address and password.',
  locked: 'Your account is locked. Please contact Northbridge support to restore access.',
  temporarily_locked:
    'Too many failed sign-in attempts. Please wait 15 minutes before trying again.',
  disabled: 'This account has been disabled. Please contact Northbridge support.',
};

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

router.post(
  '/register',
  throttle({ limit: 5, windowMs: 60 * 60_000, keyPrefix: 'register', subjectField: 'email' }),
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const customer = await registerCustomer(req.body, req);

    // Sign the new customer straight in: registration is itself proof of
    // identity, so there is no reason to make them type the password again.
    const { token, csrfToken, expiresAt } = createSession('customer', customer.id, req);
    setSessionCookie(res, 'customer', token, expiresAt);

    res.status(201).json({
      customer: toCustomerSelf(customer),
      csrfToken,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Sign in / out                                                              */
/* -------------------------------------------------------------------------- */

router.post(
  '/login',
  throttle({
    limit: LOGIN_LIMIT,
    windowMs: LOGIN_WINDOW_MS,
    blockMs: 30 * 60_000,
    keyPrefix: 'customer-login',
    subjectField: 'email',
  }),
  validateBody(customerLoginSchema),
  asyncHandler(async (req, res) => {
    const result = await authenticateCustomer(req.body.email, req.body.password);

    if (!result.ok) {
      recordThrottleFailure(req, { limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS, blockMs: 30 * 60_000 });
      recordAudit({
        actorType: 'customer',
        actorEmail: req.body.email,
        action: AUDIT_ACTIONS.CUSTOMER_LOGIN_FAILED,
        targetType: 'customer',
        metadata: { reason: result.reason },
        request: req,
      });
      throw unauthorized(LOGIN_MESSAGES[result.reason] ?? LOGIN_MESSAGES.invalid_credentials);
    }

    clearThrottle(req);

    // Replace any pre-existing session so a fixated cookie cannot survive a
    // fresh sign-in.
    const previous = req.cookies?.[cookieNameFor('customer')];
    if (previous) revokeSession(previous, 'customer');

    const { token, csrfToken, expiresAt } = createSession('customer', result.customer.id, req);
    setSessionCookie(res, 'customer', token, expiresAt);

    recordAudit({
      actorType: 'customer',
      actorId: result.customer.id,
      actorEmail: result.customer.email,
      action: AUDIT_ACTIONS.CUSTOMER_LOGIN,
      targetType: 'customer',
      targetId: result.customer.id,
      targetLabel: result.customer.account_number,
      request: req,
    });

    res.json({
      customer: toCustomerSelf(result.customer),
      csrfToken,
      // A frozen account may sign in to view, but the UI should say so.
      restrictions: result.restricted ? [result.restricted] : [],
    });
  }),
);

router.post(
  '/logout',
  attachAuth('customer'),
  requireCsrf,
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[cookieNameFor('customer')];
    if (token) revokeSession(token, 'customer');
    clearSessionCookie(res, 'customer');

    if (req.auth) {
      recordAudit({
        actorType: 'customer',
        actorId: req.auth.actorId,
        actorEmail: req.auth.actor.email,
        action: AUDIT_ACTIONS.CUSTOMER_LOGOUT,
        targetType: 'customer',
        targetId: req.auth.actorId,
        targetLabel: req.auth.actor.account_number,
        request: req,
      });
    }

    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Session probe + CSRF token                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Called on app boot to restore the session after a page refresh, and to fetch
 * a fresh CSRF token. Always 200, returning `customer: null` when signed out, so
 * the SPA can treat it as a state check rather than an error path.
 */
router.get(
  '/session',
  attachAuth('customer'),
  asyncHandler(async (req, res) => {
    res.json({
      authenticated: Boolean(req.auth),
      customer: req.auth ? toCustomerSelf(req.auth.actor) : null,
      csrfToken: req.auth?.csrfToken ?? null,
      rules: bankingRules(),
    });
  }),
);

/** Sign-in attempts are rate limited; surface the remaining window politely. */
router.get(
  '/login-status',
  asyncHandler(async (_req, res) => {
    res.json({ rules: bankingRules() });
  }),
);

/* -------------------------------------------------------------------------- */
/* Credential management                                                      */
/* -------------------------------------------------------------------------- */

router.post(
  '/change-password',
  attachAuth('customer'),
  requireCsrf,
  requireCustomer,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    await changePassword(req.auth.actorId, req.body.currentPassword, req.body.newPassword, req);
    res.json({ ok: true, message: 'Your password has been updated.' });
  }),
);

router.post(
  '/change-transfer-pin',
  attachAuth('customer'),
  requireCsrf,
  requireCustomer,
  validateBody(changePinSchema),
  asyncHandler(async (req, res) => {
    await changeTransferPin(
      req.auth.actorId,
      req.body.currentPassword,
      req.body.currentTransferPin,
      req.body.newTransferPin,
      req,
    );
    res.json({ ok: true, message: 'Your transfer PIN has been updated.' });
  }),
);

export default router;