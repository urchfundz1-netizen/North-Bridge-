/**
 * Administrator authentication routes.
 *
 * Mounted at /api/admin/auth - a completely separate namespace from customer
 * authentication. Administrators authenticate against the `admins` table with
 * their own password hashes, receive a different cookie, and can never resolve
 * a customer session. Customer credentials are not accepted here, and vice
 * versa.
 */

import { Router } from 'express';
import { coll, C, coerceId, getById, setById, nowIso } from '../../db/firestore.js';
import { verifySecret, needsRehash, hashSecret } from '../../core/crypto.js';
import { validateBody } from '../../middleware/validate.js';
import { throttle, clearThrottle, recordThrottleFailure } from '../../middleware/throttle.js';
import { attachAuth, requireAdmin, requireCsrf } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/error-handler.js';
import { adminLoginSchema, changePasswordSchema } from '../schemas.js';
import { toAdminSelf } from '../serializers.js';
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  cookieNameFor,
} from '../../core/session.js';
import { recordAudit, AUDIT_ACTIONS } from '../../services/audit.js';
import { unauthorized, validationFailed } from '../../core/errors.js';

const router = Router();

const LOGIN_LIMIT = 6;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MINUTES = 15;

/**
 * A syntactically valid hash used to burn CPU when the email is unknown, so the
 * response time does not reveal which administrator accounts exist.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

const FAILURE_MESSAGES = {
  invalid_credentials: 'We could not match that email address and password.',
  disabled: 'This administrator account has been disabled.',
  temporarily_locked: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.',
  locked: 'This administrator account is locked. Contact your system administrator.',
};

router.post(
  '/login',
  throttle({
    limit: LOGIN_LIMIT,
    windowMs: LOGIN_WINDOW_MS,
    blockMs: 30 * 60_000,
    keyPrefix: 'admin-login',
    subjectField: 'email',
  }),
  validateBody(adminLoginSchema),
  asyncHandler(async (req, res) => {
    const email = String(req.body.email).toLowerCase();
    const admin = await findAdminByEmail(email);

    if (!admin) {
      await verifySecret(String(req.body.password), DUMMY_HASH);
      await recordFailure(req, email, null);
      throw unauthorized(FAILURE_MESSAGES.invalid_credentials);
    }

    const valid = await verifySecret(String(req.body.password), admin.password_hash);
    if (!valid) {
      const { lockedUntil } = await recordFailure(req, email, admin);
      throw unauthorized(lockedUntil ? FAILURE_MESSAGES.locked : FAILURE_MESSAGES.invalid_credentials);
    }

    if (admin.status !== 'active') {
      await recordAudit({
        actorType: 'admin',
        actorId: admin.id,
        actorEmail: admin.email,
        action: AUDIT_ACTIONS.ADMIN_LOGIN_FAILED,
        metadata: { reason: 'disabled' },
        request: req,
      });
      throw unauthorized(FAILURE_MESSAGES.disabled);
    }

    if (admin.locked_until && admin.locked_until > nowIso()) {
      throw unauthorized(FAILURE_MESSAGES.temporarily_locked);
    }

    clearThrottle(req);

    // Rotate the session on sign-in to prevent session fixation.
    const previous = req.cookies?.[cookieNameFor('admin')];
    if (previous) await revokeSession(previous, 'admin');

    await setById(
      C.admins,
      admin.id,
      { last_login_at: nowIso(), failed_attempts: 0, locked_until: null },
      { merge: true },
    );

    // Upgrade hashes stored under older cost parameters.
    if (needsRehash(admin.password_hash)) {
      const upgraded = await hashSecret(req.body.password);
      await setById(C.admins, admin.id, { password_hash: upgraded }, { merge: true });
    }

    const { token, csrfToken, expiresAt } = await createSession('admin', admin.id, req);
    setSessionCookie(res, 'admin', token, expiresAt);

    await recordAudit({
      actorType: 'admin',
      actorId: admin.id,
      actorEmail: admin.email,
      action: AUDIT_ACTIONS.ADMIN_LOGIN,
      targetType: 'admin',
      targetId: admin.id,
      targetLabel: admin.email,
      request: req,
    });

    res.json({ admin: toAdminSelf({ ...admin, failed_attempts: 0 }), csrfToken });
  }),
);

router.post(
  '/logout',
  attachAuth('admin'),
  requireCsrf,
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[cookieNameFor('admin')];
    if (token) await revokeSession(token, 'admin');
    clearSessionCookie(res, 'admin');

    await recordAudit({
      actorType: 'admin',
      actorId: req.auth.actorId,
      actorEmail: req.auth.actor.email,
      action: AUDIT_ACTIONS.ADMIN_LOGOUT,
      targetType: 'admin',
      targetId: req.auth.actorId,
      targetLabel: req.auth.actor.email,
      request: req,
    });

    res.json({ ok: true });
  }),
);

/** Session probe used by the admin SPA on boot. */
router.get(
  '/session',
  attachAuth('admin'),
  asyncHandler(async (req, res) => {
    res.json({
      authenticated: Boolean(req.auth),
      admin: req.auth ? toAdminSelf(req.auth.actor) : null,
      csrfToken: req.auth?.csrfToken ?? null,
    });
  }),
);

/** Change the signed-in administrator's own password. */
router.post(
  '/change-password',
  attachAuth('admin'),
  requireCsrf,
  requireAdmin,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const admin = await getById(C.admins, req.auth.actorId);

    const valid = await verifySecret(String(req.body.currentPassword), admin.password_hash);
    if (!valid) {
      throw validationFailed({ currentPassword: 'Your current password is incorrect.' });
    }

    await setById(
      C.admins,
      admin.id,
      { password_hash: await hashSecret(req.body.newPassword), updated_at: nowIso() },
      { merge: true },
    );

    await recordAudit({
      actorType: 'admin',
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'admin.password_changed',
      targetType: 'admin',
      targetId: admin.id,
      targetLabel: admin.email,
      request: req,
    });

    res.json({ ok: true, message: 'Your password has been updated.' });
  }),
);

/* -------------------------------------------------------------------------- */

/** Look up an administrator by (lower-cased) email address. */
async function findAdminByEmail(email) {
  const snap = await coll(C.admins).where('email', '==', email).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: coerceId(doc.id), ...doc.data() };
}

/**
 * Increment the persistent failure counter, locking the account once the limit
 * is reached. The in-memory IP throttle still applies on top of this.
 */
async function recordFailure(req, email, admin) {
  recordThrottleFailure(req, { limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS, blockMs: 30 * 60_000 });

  await recordAudit({
    actorType: 'admin',
    actorEmail: email,
    action: AUDIT_ACTIONS.ADMIN_LOGIN_FAILED,
    metadata: { reason: 'invalid_credentials' },
    request: req,
  });

  if (!admin) return { lockedUntil: null };

  const attempts = (admin.failed_attempts ?? 0) + 1;
  const shouldLock = attempts >= LOGIN_LIMIT;
  const lockedUntil = shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null;

  await setById(
    C.admins,
    admin.id,
    { failed_attempts: attempts, locked_until: lockedUntil, updated_at: nowIso() },
    { merge: true },
  );

  return { lockedUntil };
}

export default router;