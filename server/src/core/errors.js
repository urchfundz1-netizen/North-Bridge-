/**
 * Application error type and helpers.
 *
 * Anything thrown as an `ApiError` is considered safe to show the client: the
 * message is written for end users, not developers. Everything else becomes a
 * generic 500 so internal details (SQL, file paths, stack traces) can never
 * leak.
 */

export class ApiError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} code    Stable machine-readable code for the frontend
   * @param {string} message Human-readable, safe to display
   * @param {object} [details] Optional field-level validation details
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const badRequest = (message, details) =>
  new ApiError(400, 'bad_request', message, details);

export const validationFailed = (details, message = 'Please correct the highlighted fields.') =>
  new ApiError(422, 'validation_failed', message, details);

export const unauthorized = (message = 'Please sign in to continue.') =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new ApiError(403, 'forbidden', message);

export const notFound = (message = 'The requested resource could not be found.') =>
  new ApiError(404, 'not_found', message);

export const conflict = (message, details) => new ApiError(409, 'conflict', message, details);

export const tooManyRequests = (message = 'Too many attempts. Please wait and try again.') =>
  new ApiError(429, 'too_many_requests', message);

export const internal = (message = 'An unexpected error occurred. Please try again.') =>
  new ApiError(500, 'internal_error', message);