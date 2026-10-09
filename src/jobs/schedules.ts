import { asPlatform } from '../core/context';
import { logger } from '../core/logger';
import { todayLagos } from '../lib/dates';
import { School } from '../models';
import { enqueue } from './queue';

/**
 * Scheduled jobs (Document 3, section 12.2). Each tick enqueues work with a uniqueKey for the period, so two workers
 * running the same schedule create each job once.
 *
 *   every 30 minutes   reconcile-payments   verify payments stuck in "initiated"
 *   daily              expire-offers        mark unpaid offers past their date as expired
 *   daily              fee-reminders        notify parents with open balances, on each school's schedule
 *   daily              cleanup              remove expired upload links, old drafts and expired exports
 */
export function startSchedules(): NodeJS.Timeout[] {
  const every = (ms: number, fn: () => Promise<void>) =>
    setInterval(() => {
      fn().catch((e) => logger.error({ err: e }, 'schedule tick failed'));
    }, ms);

  const slot30 = () => `${todayLagos()}T${Math.floor(Date.now() / (30 * 60_000))}`;

  const timers: NodeJS.Timeout[] = [];
  timers.push(
    every(5 * 60_000, async () => {
      await enqueue('reconcile-payments', {}, { uniqueKey: `reconcile:${slot30()}` });
    })
  );
  timers.push(
    every(60 * 60_000, async () => {
      const day = todayLagos();
      await enqueue('cleanup', {}, { uniqueKey: `cleanup:${day}` });
      const schools = await asPlatform(() => School.find({ status: 'active' }).select('_id').lean());
      for (const s of schools) {
        const id = String(s._id);
        await enqueue('expire-offers', {}, { schoolId: id, uniqueKey: `expire-offers:${id}:${day}` });
        await enqueue('fee-reminders', { scheduled: true }, { schoolId: id, uniqueKey: `fee-reminders:${id}:${day}` });
      }
    })
  );
  return timers;
}
