/**
 * Request validation middleware.
 *
 * Validates the request body against a Zod schema and replaces it with the
 * parsed result, so route handlers always receive coerced, trimmed, known-shape
 * data. Anything unexpected is stripped rather than passed through to SQL.
 */

import { ZodError } from 'zod';
import { validationFailed } from '../core/errors.js';

/** Convert a Zod issue list into `{ fieldName: message }` for form rendering. */
function toFieldErrors(error) {
  const details = {};
  for (const issue of error.issues) {
    const field = issue.path.length ? issue.path.join('.') : '_';
    if (!details[field]) details[field] = issue.message;
  }
  return details;
}

export function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      return next(validationFailed(toFieldErrors(result.error)));
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      return next(validationFailed(toFieldErrors(result.error)));
    }
    // Express 5 exposes req.query as a getter-only property, so stash the
    // parsed value separately rather than assigning to it.
    req.validatedQuery = result.data;
    next();
  };
}

/** Re-exported so route modules can build schemas without importing zod. */
export { ZodError };