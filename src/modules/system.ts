import express from 'express';
import mongoose from 'mongoose';
import { createRoutes } from '../core/route';
import { z, objectId } from '../core/validate';
import { ok, Reply, me } from '../core/http';
import { notFound, validation } from '../core/errors';
import { files, localSave, verifyLocalToken, type Purpose } from '../integrations/storage';
import { queueHealth, redisClient } from '../jobs/queue';
import { asPlatform } from '../core/context';
import { Job } from '../models';
import * as filesSvc from '../services/files';
import { transactionsSupported } from '../core/db';
import { AppError } from '../core/errors';

const r = createRoutes();
export const router = r.router;

// ------------------------------------------------------------------ health

r.get('/health', { access: 'public', summary: 'Service health: database, Redis and the queue' }, async () => {
  const db = mongoose.connection.readyState === 1;
  let redis: 'up' | 'down' | 'not_configured' = 'not_configured';
  const rc = redisClient();
  if (rc) redis = (await rc.ping().then(() => true).catch(() => false)) ? 'up' : 'down';
  const queue = await queueHealth();
  const healthy = db && redis !== 'down' && queue.ok;
  return new Reply(healthy ? 200 : 503, { data: { status: healthy ? 'ok' : 'degraded', database: db ? 'up' : 'down', redis, queue, transactions: transactionsSupported() } });
});

// ------------------------------------------------------------------ files

const purposeEnum = z.enum(['site_image', 'brand_asset', 'student_photo', 'student_document', 'task_file', 'submission_file', 'payment_proof', 'import_file']);

r.post(
  '/files/sign',
  { access: 'any', body: z.object({ purpose: purposeEnum, mime: z.string().max(120), size: z.number().int().positive().optional() }).strict(), summary: 'Signed upload parameters for a stated purpose' },
  async (req) => ok(await filesSvc.signUpload(req.body.purpose as Purpose, req.body.mime, req.body.size))
);

r.get('/files/link', { access: 'any', query: z.object({ ref: z.string().min(10).max(300) }).strict(), summary: 'A short-lived link to a private file' }, async (req) => ok(await filesSvc.privateLink(req.query.ref as string)));

// Local disk driver (development): the browser PUTs the file to a signed address, and reads private files from signed links.
export const localFileRoutes = express.Router();
localFileRoutes.put('/files/local-upload/:token', express.raw({ type: '*/*', limit: '12mb' }), async (req, res, next) => {
  try {
    const token = verifyLocalToken(req.params.token);
    const ct = (req.header('content-type') ?? '').split(';')[0];
    if (token.mime && ct !== token.mime) throw validation('The file type does not match what was requested.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw validation('The file is empty.');
    await localSave(token, req.body);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});
localFileRoutes.get('/files/local/:token', async (req, res, next) => {
  try {
    const token = verifyLocalToken(req.params.token);
    const buf = await files.getBuffer(token.ref);
    const ext = token.ref.split('.').pop();
    const mime = ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', csv: 'text/csv', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  } catch (e) {
    next(e instanceof AppError ? e : notFound('File'));
  }
});

// ------------------------------------------------------------------ jobs

r.get('/jobs/:id', { access: 'any', params: z.object({ id: objectId }).strict(), inactiveOk: true, summary: 'Status of a background job the caller started' }, async (req) => {
  const c = me();
  const job = await asPlatform(() => Job.findById(req.params.id).lean());
  if (!job || String(job.userId ?? '') !== c.userId || (job.schoolId && String(job.schoolId) !== (c.schoolId ?? ''))) throw notFound('Job');
  return ok({ id: String(job._id), kind: job.kind, status: job.status, progress: job.progress, result: job.status === 'done' ? job.result : undefined, error: job.status === 'failed' ? job.error : undefined });
});
