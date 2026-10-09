export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'support_blocked'
  | 'not_found'
  | 'validation_failed'
  | 'duplicate'
  | 'state_conflict'
  | 'term_closed'
  | 'result_locked'
  | 'incomplete_scores'
  | 'school_not_active'
  | 'bank_not_set'
  | 'payment_provider_error'
  | 'idempotency_conflict'
  | 'no_sms_units'
  | 'rate_limited'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  support_blocked: 403,
  not_found: 404,
  validation_failed: 422,
  duplicate: 409,
  state_conflict: 409,
  term_closed: 409,
  result_locked: 409,
  incomplete_scores: 409,
  school_not_active: 403,
  bank_not_set: 409,
  payment_provider_error: 502,
  idempotency_conflict: 409,
  no_sms_units: 409,
  rate_limited: 429,
  internal_error: 500
};

export class AppError extends Error {
  status: number;
  code: ErrorCode;
  fields?: Record<string, string>;
  details?: unknown;
  retryAfter?: number;

  constructor(code: ErrorCode, message: string, opts: { fields?: Record<string, string>; details?: unknown; retryAfter?: number } = {}) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.fields = opts.fields;
    this.details = opts.details;
    this.retryAfter = opts.retryAfter;
  }
}

export const unauthenticated = (m = 'Sign in to continue.') => new AppError('unauthenticated', m);
export const forbidden = (m = 'You do not have permission to do this.') => new AppError('forbidden', m);
export const notFound = (what = 'Record') => new AppError('not_found', `${what} was not found.`);
export const validation = (message: string, fields?: Record<string, string>) =>
  new AppError('validation_failed', message, { fields });
export const duplicate = (m: string, details?: unknown) => new AppError('duplicate', m, { details });
export const stateConflict = (m: string, details?: unknown) => new AppError('state_conflict', m, { details });
export const termClosed = () => new AppError('term_closed', 'This term is closed. Ask the principal to reopen it.');
