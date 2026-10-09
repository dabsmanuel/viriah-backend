import { enqueue } from '../src/jobs/queue';
import { Job } from '../src/models';
import { drainJobs, platform } from './helpers';

/** Run the reconciliation job now and return what it did. */
export async function reconcileNow(): Promise<{ checked: number; completed: number; abandoned: number }> {
  const id = await enqueue('reconcile-payments', {});
  await drainJobs();
  const job = await platform(() => Job.findById(id).lean());
  if (job.status !== 'done') throw new Error(`reconcile failed: ${job.error}`);
  return job.result;
}
