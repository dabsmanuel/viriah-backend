import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { AppError } from './errors';
import { zodFields } from './validate';
import { logger } from './logger';
import { getCtx } from './context';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'That address does not exist.', requestId: getCtx()?.requestId } });
};

/** All errors leave in the shape { error: { code, message, fields?, requestId } } (API 1.4). */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = getCtx()?.requestId ?? (req as any).id;
  let app: AppError;

  if (err instanceof AppError) app = err;
  else if (err instanceof ZodError) app = new AppError('validation_failed', 'Some fields need attention.', { fields: zodFields(err) });
  else if (err instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(err.errors)) fields[k] = v.message;
    app = new AppError('validation_failed', 'Some fields need attention.', { fields });
  } else if (err instanceof mongoose.Error.CastError) app = new AppError('not_found', 'Record was not found.');
  else if (err?.code === 11000) {
    const key = Object.keys(err.keyPattern ?? {}).filter((k) => k !== 'schoolId')[0] ?? 'value';
    app = new AppError('duplicate', `A record with this ${key} already exists.`, { fields: { [key]: 'Already in use.' } });
  } else if (err?.type === 'entity.too.large') app = new AppError('validation_failed', 'The request is too large.');
  else if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) app = new AppError('validation_failed', 'The request body is not valid JSON.');
  else {
    logger.error({ err, requestId, path: req.path }, 'unhandled error');
    app = new AppError('internal_error', 'Something went wrong on our side. Try again, and tell us the request ID if it keeps happening.');
  }

  if (app.fields) res.locals.errorFields = app.fields; // the access log prints which fields were refused
  if (app.retryAfter) res.setHeader('Retry-After', String(app.retryAfter));
  res.status(app.status).json({
    error: {
      code: app.code,
      message: app.message,
      ...(app.fields ? { fields: app.fields } : {}),
      ...(app.details ? { details: app.details } : {}),
      requestId
    }
  });
};
