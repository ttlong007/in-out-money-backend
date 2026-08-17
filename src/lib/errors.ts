/**
 * Error shape.
 *
 * Every failure the client can act on is an `ApiError` with a stable machine
 * `code`. The client branches on the code, never on the message — messages are
 * for humans reading logs and are free to change.
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ApiErrorCode =
  | 'validation_error'
  | 'invalid_credentials'
  | 'email_taken'
  | 'unauthorized'
  | 'token_expired'
  | 'token_revoked'
  | 'not_found'
  | 'rate_limited'
  | 'reset_unavailable'
  | 'reset_invalid'
  | 'reset_expired'
  | 'ai_unavailable'
  | 'ai_failed'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: ContentfulStatusCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError('validation_error', 400, message, details);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError('unauthorized', 401, message);
  }

  static notFound(message = 'Not found'): ApiError {
    return new ApiError('not_found', 404, message);
  }
}

export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  }

  // Anything reaching here is a bug rather than an expected outcome, so it is
  // logged in full and reported to the client without detail — an unexpected
  // failure must never leak a stack trace or a connection string.
  console.error('[error] unhandled:', error);
  return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
}
