/**
 * Request throttling middleware.
 *
 * Backstops brute-force attacks against login endpoints and transfer-PIN
 * confirmation. Applied per-IP and, where a body field is available, per
 * account, so neither a single IP spraying many accounts nor many IPs targeting
 * one account can succeed.
 */

import { checkRateLimit, recordFailure, clearFailures } from '../core/session.js';
import { tooManyRequests } from '../core/errors.js';
import { clientIp } from '../services/audit.js';

/**
 * @param {object} options
 * @param {number} options.limit  failures allowed within the window
 * @param {number} options.windowMs
 * @param {number} options.blockMs
 * @param {string} [options.keyPrefix] namespace, e.g. 'customer-login'
 * @param {string} [options.subjectField] body field to also throttle per account
 */
export function throttle({ limit, windowMs, blockMs = 15 * 60 * 1000, keyPrefix, subjectField }) {
  return (req, _res, next) => {
    const keys = [`${keyPrefix}:ip:${clientIp(req)}`];
    const subject = subjectField ? req.body?.[subjectField] : null;
    if (subject) keys.push(`${keyPrefix}:subject:${String(subject).toLowerCase()}`);

    for (const key of keys) {
      const result = checkRateLimit(key, { limit, windowMs, blockMs });
      if (!result.allowed) {
        req.app.locals.retryAfter = result.retryAfterSeconds;
        return next(
          tooManyRequests(
            `Too many attempts. Please try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
          ),
        );
      }
    }

    req.throttleKeys = keys;
    next();
  };
}

/** Called by a route after a successful authentication. */
export function clearThrottle(req) {
  for (const key of req.throttleKeys ?? []) clearFailures(key);
}

/** Called by a route after a failed authentication. */
export function recordThrottleFailure(req, { limit, windowMs, blockMs = 15 * 60 * 1000 } = {}) {
  for (const key of req.throttleKeys ?? []) {
    recordFailure(key, limit, windowMs, blockMs);
  }
}