// =============================================================================
// Fleet Commander — ServiceError base class
// =============================================================================
// Typed error class for service layer exceptions. Routes catch ServiceError
// instances and map them to HTTP responses based on the statusCode.
// This decouples business logic errors from HTTP transport concerns.
// =============================================================================

/**
 * Base error class for service-layer failures.
 *
 * @param message - Human-readable error description
 * @param code - Machine-readable error code (e.g. 'NOT_FOUND', 'VALIDATION')
 * @param statusCode - HTTP status code to return (e.g. 400, 404, 409, 502)
 */
export class ServiceError extends Error {
  /** Machine-readable error code */
  readonly code: string;
  /** Suggested HTTP status code for the error */
  readonly statusCode: number;
  /** Optional extra details (e.g. CLI stderr output) */
  readonly details?: string;

  constructor(message: string, code: string, statusCode: number, details?: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Convenience factory functions for common error types
// ---------------------------------------------------------------------------

/** 400 Bad Request — validation failures */
export function validationError(message: string): ServiceError {
  return new ServiceError(message, 'VALIDATION', 400);
}

/** 404 Not Found — entity lookup failures */
export function notFoundError(message: string): ServiceError {
  return new ServiceError(message, 'NOT_FOUND', 404);
}

/** 409 Conflict — duplicate or state-conflict errors */
export function conflictError(message: string): ServiceError {
  return new ServiceError(message, 'CONFLICT', 409);
}

/** 502 Bad Gateway — external tool/CLI failures */
export function externalError(message: string, details?: string): ServiceError {
  return new ServiceError(message, 'EXTERNAL_ERROR', 502, details);
}
