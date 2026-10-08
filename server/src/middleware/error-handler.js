/**
 * Error handling middleware.
 *
 * ApiError messages are shown to the user verbatim. Everything else is logged
 * in full server-side but replaced with a generic message, so SQL text, file
 * paths and stack traces never reach a client.
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

  // Translate the SQLite integrity constraints into user-meaningful errors
  // instead of leaking "UNIQUE constraint failed".
  const sqliteMessage = String(error?.message ?? '');

  if (sqliteMessage.includes('UNIQUE constraint failed: customers.email')) {
    return res.status(409).json({
      error: { code: 'email_taken', message: 'An account already exists for that email address.' },
    });
  }
  if (sqliteMessage.includes('UNIQUE constraint failed: customers.account_number')) {
    return res.status(409).json({
      error: { code: 'account_exists', message: 'That account number is already in use.' },
    });
  }
  if (sqliteMessage.includes('UNIQUE constraint failed: transfers.idempotency_key')) {
    return res.status(409).json({
      error: {
        code: 'duplicate_transfer',
        message: 'This transfer has already been submitted.',
      },
    });
  }
  if (sqliteMessage.includes('UNIQUE constraint failed: ledger_entries')) {
    return res.status(409).json({
      error: {
        code: 'already_settled',
        message: 'This transaction has already been settled and cannot be applied again.',
      },
    });
  }
  if (sqliteMessage.includes('CHECK constraint failed: customers.balance_cents')) {
    return res.status(409).json({
      error: { code: 'insufficient_funds', message: 'Insufficient available balance.' },
    });
  }
  if (sqliteMessage.includes('append-only')) {
    return res.status(409).json({
      error: {
        code: 'immutable_record',
        message: 'Compliance records cannot be modified or deleted.',
      },
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