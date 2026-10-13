/**
 * Error handling middleware.
 *
 * ApiError messages are shown to the user verbatim. Everything else is logged
 * in full server-side but replaced with a generic message, so file paths and
 * stack traces never reach a client.
 */

import { ApiError } from '../core/errors.js';
import { config } from '../core/config.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: `No API route matches ${req.method} ${req.path}`,
    },
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(error, req, res, next) {
  if (error instanceof ApiError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }

  // Safety net for a unique constraint violation that a service did not
  // translate into a friendlier ApiError of its own.
  if (error?.code === 'unique_violation') {
    return res.status(409).json({
      error: { code: 'conflict', message: 'That value is already in use.' },
    });
  }

  console.error('[error]', {
    method: req.method,
    path: req.path,
    message: error?.message,
    stack: config.isProduction ? undefined : error?.stack,
  });

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred. Please try again.',
    },
  });
}

/** Wrap an async route handler so rejected promises reach the error handler. */
export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}