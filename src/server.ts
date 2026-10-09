import { createApp } from './app';
import { env } from './config/env';
import { connectDb, disconnectDb } from './core/db';
import { logger } from './core/logger';
import { closeQueue } from './jobs/queue';
import './models';
import './jobs/register';

async function main() {
  await connectDb();
  const app = createApp();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.APP_ENV }, 'API listening'));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await closeQueue();
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
   
  console.error(e);
  process.exit(1);
});
