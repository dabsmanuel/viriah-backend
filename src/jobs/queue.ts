import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env, isTest } from '../config/env';
import { asPlatform, emptyCtx, forSchool, runWithCtx } from '../core/context';
import { logger } from '../core/logger';
import { Job } from '../models';

/**
 * Slow work (PDFs, SMS, email, bulk invoices, imports) runs in a worker so screens stay fast. BullMQ on Redis in
 * staging and production. With no REDIS_URL an in-process runner is used, with the same retry rules, so local
 * development needs no Redis. Every job has a document so clients can poll GET /jobs/{id} and the super admin can
 * see and retry failed jobs. Jobs carry schoolId and run inside forSchool(id). Jobs retry safely and can run twice.
 */

export interface JobContext {
  jobId: string;
  schoolId?: string;
  userId?: string;
  payload: any;
  progress(n: number): Promise<void>;
}
export type Processor = (job: JobContext) => Promise<unknown>;

const processors = new Map<string, Processor>();
export const registerJob = (kind: string, p: Processor) => processors.set(kind, p);
export const hasJob = (kind: string) => processors.has(kind);

export interface EnqueueOpts {
  schoolId?: string;
  userId?: string;
  /** makes a job safe to enqueue twice: the existing job is returned */
  uniqueKey?: string;
  delayMs?: number;
}

const MAX_ATTEMPTS = 4;
const backoffMs = (attempt: number) => Math.min(60_000, 2000 * 2 ** (attempt - 1));

let queue: Queue | undefined;
let connection: IORedis | undefined;
const inflight = new Set<Promise<unknown>>();

function redis(): ConnectionOptions | undefined {
  if (!env.REDIS_URL) return undefined;
  connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection as unknown as ConnectionOptions;
}

export const redisClient = (): IORedis | undefined => {
  redis();
  return connection;
};

function bull(): Queue | undefined {
  const c = redis();
  if (!c) return undefined;
  queue ??= new Queue('viriah', { connection: c, defaultJobOptions: { attempts: MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 } });
  return queue;
}

export async function enqueue(kind: string, payload: Record<string, unknown> = {}, opts: EnqueueOpts = {}): Promise<string> {
  const exec = () =>
    asPlatform(async () => {
      if (opts.uniqueKey) {
        const existing = await Job.findOne({ uniqueKey: opts.uniqueKey, status: { $in: ['queued', 'running', 'done'] } }).lean();
        if (existing) return String(existing._id);
      }
      const doc = await Job.create({ kind, payload, schoolId: opts.schoolId, userId: opts.userId, uniqueKey: opts.uniqueKey, status: 'queued' });
      const id = String(doc._id);
      const q = bull();
      if (q) await q.add(kind, { jobId: id }, { delay: opts.delayMs });
      else dispatchInline(id, opts.delayMs ?? 0);
      return id;
    });
  return exec();
}

function dispatchInline(jobId: string, delayMs = 0) {
  const p = new Promise<void>((resolve) => {
    setTimeout(async () => {
      try {
        await runJob(jobId);
      } catch (e) {
        logger.error({ err: e, jobId }, 'inline job crashed');
      } finally {
        resolve();
      }
    }, delayMs);
  });
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Tests and scripts: wait for in-process jobs to finish. */
export async function drainJobs(timeoutMs = 30_000) {
  const start = Date.now();
  while (inflight.size && Date.now() - start < timeoutMs) await Promise.allSettled([...inflight]);
}

/** Run one job, with the right tenant context. Returns when it has finished (or failed for good). */
export async function runJob(jobId: string): Promise<void> {
  const job = await asPlatform(() => Job.findById(jobId));
  if (!job) return;
  if (job.status === 'done') return;
  const processor = processors.get(job.kind);
  if (!processor) {
    await asPlatform(() => Job.updateOne({ _id: job._id }, { status: 'failed', error: `No processor for ${job.kind}`, finishedAt: new Date() }));
    return;
  }
  const attempt = (job.attempts ?? 0) + 1;
  await asPlatform(() => Job.updateOne({ _id: job._id }, { status: 'running', attempts: attempt, startedAt: new Date(), error: undefined }));
  const schoolId = job.schoolId ? String(job.schoolId) : undefined;
  const ctx = { ...emptyCtx(), userId: job.userId ? String(job.userId) : undefined };
  const jc: JobContext = {
    jobId,
    schoolId,
    userId: ctx.userId,
    payload: job.payload,
    progress: async (n) => {
      await asPlatform(() => Job.updateOne({ _id: job._id }, { progress: Math.max(0, Math.min(100, Math.round(n))) }));
    }
  };
  try {
    const result = await runWithCtx(ctx, () => (schoolId ? forSchool(schoolId, () => processor(jc)) : asPlatform(() => processor(jc))));
    await asPlatform(() => Job.updateOne({ _id: job._id }, { status: 'done', progress: 100, result: result ?? null, finishedAt: new Date() }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, jobId, kind: job.kind, attempt }, 'job failed');
    await asPlatform(() => Job.updateOne({ _id: job._id }, { status: 'failed', error: message.slice(0, 500), finishedAt: new Date() }));
    if (!bull() && attempt < MAX_ATTEMPTS && !isTest) {
      await asPlatform(() => Job.updateOne({ _id: job._id }, { status: 'queued' }));
      dispatchInline(jobId, backoffMs(attempt));
    } else if (bull()) {
      // Let BullMQ retry with backoff.
      throw e;
    }
  }
}

/** Retry a failed job from the super admin console. */
export async function retryJob(jobId: string) {
  await asPlatform(() => Job.updateOne({ _id: jobId, status: 'failed' }, { status: 'queued', attempts: 0, error: undefined }));
  const q = bull();
  if (q) await q.add('retry', { jobId });
  else dispatchInline(jobId);
}

/** Start the BullMQ worker (worker.ts). Without Redis the API process already runs jobs inline. */
export function startWorker(concurrency = 5): Worker | undefined {
  const c = redis();
  if (!c) {
    logger.warn('REDIS_URL is not set: jobs run inside the API process. Start Redis to run a separate worker.');
    return undefined;
  }
  const worker = new Worker('viriah', async (j) => runJob(j.data.jobId), { connection: c, concurrency });
  worker.on('failed', (j, err) => logger.error({ jobId: j?.data?.jobId, err }, 'worker job failed'));
  return worker;
}

export async function queueHealth(): Promise<{ ok: boolean; waiting?: number; failed?: number; mode: 'bullmq' | 'inline' }> {
  const q = bull();
  if (!q) return { ok: true, mode: 'inline' };
  try {
    const counts = await q.getJobCounts('waiting', 'failed');
    return { ok: true, waiting: counts.waiting, failed: counts.failed, mode: 'bullmq' };
  } catch {
    return { ok: false, mode: 'bullmq' };
  }
}

export async function closeQueue() {
  await queue?.close();
  await connection?.quit().catch(() => undefined);
  queue = undefined;
  connection = undefined;
}
