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
  otpVerifySchema,
  registerSchema,
  changePasswordSchema,
  changePinSchema,
} from './schemas.js';
import { toCustomerSelf } from './serializers.js';
import {
  registerCustomer,
  authenticateCustomer,
  finalizeCustomerLogin,
  findCustomerById,
  changePassword,
  changeTransferPin,
} from '../services/customer-service.js';
import { createLoginChallenge, verifyLoginChallenge } from '../services/otp-service.js';
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
import { nowIso } from '../db/firestore.js';

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

/** Outcomes of the second (one-time code) step. */
const OTP_MESSAGES = {
  invalid: 'That sign-in has expired. Please enter your details again.',
  expired: 'That code has expired. Please sign in again to get a new one.',
  mismatch: 'Incorrect Pin',
  too_many_attempts: 'Too many incorrect codes. Please sign in again.',
};

const OTP_LIMIT = 10;
const OTP_WINDOW_MS = 15 * 60_000;

/** `ada.lovelace@example.com` -> `a***********@example.com`. */
function maskEmail(email) {
  const [local = '', domain = ''] = String(email ?? '').split('@');
  if (!domain) return 'your email';
  const lead = local.slice(0, 1);
  return `${lead}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

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
    const { token, csrfToken, expiresAt } = await createSession('customer', customer.id, req);
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
    const result = await authenticateCustomer(req.body.email, req.body.password, {
      recordLogin: false,
    });

    if (!result.ok) {
      recordThrottleFailure(req, { limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS, blockMs: 30 * 60_000 });
      await recordAudit({
        actorType: 'customer',
        actorEmail: req.body.email,
        action: AUDIT_ACTIONS.CUSTOMER_LOGIN_FAILED,
        targetType: 'customer',
        metadata: { reason: result.reason, stage: 'password' },
        request: req,
      });
      throw unauthorized(LOGIN_MESSAGES[result.reason] ?? LOGIN_MESSAGES.invalid_credentials);
    }

    clearThrottle(req);

    // The password checked out, but no session is issued yet: the customer must
    // first complete the one-time-code step. One code from the fixed pool is
    // reserved for this challenge and only that code will complete it.
    const challenge = await createLoginChallenge(result.customer);

    await recordAudit({
      actorType: 'customer',
      actorId: result.customer.id,
      actorEmail: result.customer.email,
      action: AUDIT_ACTIONS.CUSTOMER_LOGIN_CHALLENGED,
      targetType: 'customer',
      targetId: result.customer.id,
      targetLabel: result.customer.account_number,
      metadata: { stage: 'otp_requested' },
      request: req,
    });

    res.json({
      otpRequired: true,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      email: maskEmail(result.customer.email),
    });
  }),
);

/**
 * Complete sign-in with the 6-digit code reserved for the challenge. Only here
 * is a session created, so a correct password on its own never yields a cookie.
 */
router.post(
  '/login/verify-otp',
  throttle({
    limit: OTP_LIMIT,
    windowMs: OTP_WINDOW_MS,
    blockMs: 30 * 60_000,
    keyPrefix: 'customer-otp',
    subjectField: 'challengeId',
  }),
  validateBody(otpVerifySchema),
  asyncHandler(async (req, res) => {
    const result = await verifyLoginChallenge(req.body.challengeId, req.body.code);

    if (!result.ok) {
      recordThrottleFailure(req, { limit: OTP_LIMIT, windowMs: OTP_WINDOW_MS, blockMs: 30 * 60_000 });
      await recordAudit({
        actorType: 'customer',
        action: AUDIT_ACTIONS.CUSTOMER_LOGIN_FAILED,
        targetType: 'customer',
        metadata: { reason: result.reason, stage: 'otp' },
        request: req,
      });
      throw unauthorized(OTP_MESSAGES[result.reason] ?? OTP_MESSAGES.invalid);
    }

    clearThrottle(req);

    // Re-read the account: its standing may have changed while the code was
    // being checked, and every request must trust only the database.
    const customer = await findCustomerById(result.customerId);
    if (!customer) throw unauthorized(OTP_MESSAGES.invalid);

    if (customer.locked_until && customer.locked_until > nowIso()) {
      throw unauthorized(LOGIN_MESSAGES.temporarily_locked);
    }
    if (customer.status === 'locked') throw unauthorized(LOGIN_MESSAGES.locked);
    if (customer.status === 'disabled') throw unauthorized(LOGIN_MESSAGES.disabled);

    await finalizeCustomerLogin(customer.id);

    // Rotate the session on sign-in so a fixated cookie cannot survive it.
    const previous = req.cookies?.[cookieNameFor('customer')];
    if (previous) await revokeSession(previous, 'customer');

    const { token, csrfToken, expiresAt } = await createSession('customer', customer.id, req);
    setSessionCookie(res, 'customer', token, expiresAt);

    await recordAudit({
      actorType: 'customer',
      actorId: customer.id,
      actorEmail: customer.email,
      action: AUDIT_ACTIONS.CUSTOMER_LOGIN,
      targetType: 'customer',
      targetId: customer.id,
      targetLabel: customer.account_number,
      metadata: { stage: 'otp_verified' },
      request: req,
    });

    res.json({
      customer: toCustomerSelf(customer),
      csrfToken,
      // A frozen account may sign in to view, but the UI should say so.
      restrictions: customer.status === 'frozen' ? ['frozen'] : [],
    });
  }),
);

router.post(
  '/logout',
  attachAuth('customer'),
  requireCsrf,
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[cookieNameFor('customer')];
    if (token) await revokeSession(token, 'customer');
    clearSessionCookie(res, 'customer');

    if (req.auth) {
      await recordAudit({
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