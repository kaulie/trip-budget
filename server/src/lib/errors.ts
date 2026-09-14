/**
 * Central error types. The HTTP layer maps these onto status codes, so the
 * domain layer never needs to know about HTTP.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable'
  | 'internal';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError('bad_request', 400, message, details);

export const unauthorized = (message = 'missing or invalid credentials') =>
  new AppError('unauthorized', 401, message);

export const forbidden = (message = 'not allowed') => new AppError('forbidden', 403, message);

export const notFound = (message = 'not found', details?: Record<string, unknown>) =>
  new AppError('not_found', 404, message, details);

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError('conflict', 409, message, details);

export const unprocessable = (message: string, details?: Record<string, unknown>) =>
  new AppError('unprocessable', 422, message, details);

/** A deterministic business-rule violation (money invariants, membership, ...). */
export type RuleViolation = {
  /** Stable machine-readable code, e.g. `shares_sum_mismatch`. */
  rule: string;
  /** Human readable (Chinese) explanation shown in the app. */
  message: string;
  details?: Record<string, unknown>;
};

export class BusinessRuleError extends AppError {
  readonly violations: RuleViolation[];

  constructor(violations: RuleViolation[], message = 'business rules violated') {
    super('unprocessable', 422, message, { violations });
    this.name = 'BusinessRuleError';
    this.violations = violations;
  }
}
