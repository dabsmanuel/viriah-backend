import { connectDb, disconnectDb } from './core/db';
import { logger } from './core/logger';
import { closeQueue, startWorker } from './jobs/queue';
import { startSchedules } from './jobs/schedules';
import './models';
import './jobs/register';

/** Background worker: PDFs, SMS, email, bulk invoices, imports, scheduled jobs. Run it next to the API in staging and production. */
async function main() {
  await connectDb();
  const worker = startWorker();
  const timers = startSchedules();
  logger.info('worker started');

  const shutdown = async () => {
    timers.forEach(clearInterval);
    await worker?.close();
    await closeQueue();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((e) => {
   
  console.error(e);
  process.exit(1);
});
