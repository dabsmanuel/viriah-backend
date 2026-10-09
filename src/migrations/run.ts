import { connectDb, disconnectDb, syncIndexes } from '../core/db';

/**
 * Schema changes in a shared-database system are additive and idempotent. Each migration is a named function; the ones that
 * have run are recorded so a deploy can run `npm run migrate` every time. Index changes are applied by syncIndexes().
 */
const migrations: Array<{ name: string; run: () => Promise<void> }> = [];

async function main() {
  await connectDb();
  await syncIndexes();
  const mongoose = (await import('mongoose')).default;
  const col = mongoose.connection.collection('migrations');
  for (const m of migrations) {
    if (await col.findOne({ name: m.name })) continue;
    await m.run();
    await col.insertOne({ name: m.name, at: new Date() });
     
    console.log(`migrated ${m.name}`);
  }
   
  console.log('Indexes synced. Migrations up to date.');
  await disconnectDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
