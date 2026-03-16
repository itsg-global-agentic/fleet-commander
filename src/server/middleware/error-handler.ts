// =============================================================================
// Fleet Commander — Centralized Error Handler
// =============================================================================
// All API errors are returned in a consistent {error, code, details?} format.
// Stack traces are logged server-side only and never leaked to clients.
// =============================================================================

import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// API error response shape (returned to clients)
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Application error class
// ---------------------------------------------------------------------------

/**
 * Throw an AppError from route handlers or services to control the HTTP
 * status code, machine-readable code, and optional details sent to the client.
 *
 * Example:
 *   throw new AppError(404, 'TEAM_NOT_FOUND', `Team ${id} not found`);
 *   throw new AppError(400, 'INVALID_PAYLOAD', 'Missing team_id', { field: 'team_id' });
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// ---------------------------------------------------------------------------
// Fastify error handler
// ---------------------------------------------------------------------------

/**
 * Centralized error handler registered via `server.setErrorHandler(errorHandler)`.
 *
 * Behaviour:
 *   - AppError instances use their own statusCode and code.
 *   - Fastify validation errors (e.g. schema failures) use 400 + the error code.
 *   - All other errors default to 500 / INTERNAL_ERROR.
 *   - 5xx errors log the full stack trace; 4xx errors log a warning.
 *   - Client responses never include stack traces.
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const statusCode = error instanceof AppError
    ? error.statusCode
    : error.statusCode ?? 500;

  const code = error instanceof AppError
    ? error.code
    : error.code ?? 'INTERNAL_ERROR';

  // Server-side logging: full stack for 500s, concise warning for 4xx
  if (statusCode >= 500) {
    request.log.error({ err: error, url: request.url }, 'Internal server error');
  } else {
    request.log.warn({ code, url: request.url, statusCode }, error.message);
  }

  // Build client-safe response — never leak stack traces
  const response: ApiError = {
    error: statusCode >= 500 ? 'Internal server error' : error.message,
    code,
    details: error instanceof AppError ? error.details : undefined,
  };

  reply.status(statusCode).send(response);
}
