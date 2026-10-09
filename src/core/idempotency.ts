import type { Request, RequestHandler } from 'express';
import { getCtx } from './context';
import { AppError, validation } from './errors';
import { requestHash } from '../lib/crypto';
import { IdempotencyKey } from '../models';
import { daysFromNow } from '../lib/dates';

/**
 * Safe retries (API 1.7). POST requests that create money records or bulk records send an Idempotency-Key header.
 * The server stores the key with the response for 24 hours. A repeat with the same key and body returns the stored
 * response. A repeat with a different body returns idempotency_conflict.
 */
export function idempotency(routeKey: string): RequestHandler {
  return async (req: Request, res, next) => {
    try {
      const key = req.header('Idempotency-Key');
      if (!key) throw validation('Send an Idempotency-Key header with this request.', { 'Idempotency-Key': 'Required.' });
      if (key.length < 8 || key.length > 128) throw validation('The Idempotency-Key must be 8 to 128 characters.');
      const scope = getCtx()?.userId ?? req.ip ?? 'anon';
      const bodyHash = requestHash({ b: req.body, q: req.query, p: req.params });

      let doc;
      try {
        doc = await IdempotencyKey.create({ scope, key, route: routeKey, bodyHash, expiresAt: daysFromNow(1) });
      } catch (e: any) {
        if (e?.code !== 11000) throw e;
        const existing = await IdempotencyKey.findOne({ scope, key, route: routeKey }).lean();
        if (!existing) throw e;
        if (existing.bodyHash !== bodyHash) throw new AppError('idempotency_conflict', 'This Idempotency-Key was used with a different request.');
        if (existing.state === 'done' && existing.response) {
          res.setHeader('Idempotent-Replay', 'true');
          res.status(existing.response.status).json(existing.response.body);
          return;
        }
        throw new AppError('state_conflict', 'This request is still being processed. Wait a moment and try again.');
      }

      // Capture the response so a repeat can return it.
      const send = res.json.bind(res);
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        if (status >= 500) {
          // A server error is not stored: the client may retry with the same key.
          void IdempotencyKey.deleteOne({ _id: doc._id }).catch(() => undefined);
        } else {
          void IdempotencyKey.updateOne({ _id: doc._id }, { state: 'done', response: { status, body } }).catch(() => undefined);
        }
        return send(body);
      }) as typeof res.json;
      next();
    } catch (e) {
      next(e);
    }
  };
}
