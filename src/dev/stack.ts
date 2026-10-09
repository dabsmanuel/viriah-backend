/**
 * npm run dev:stack
 * One command for local development without installing MongoDB or Redis: starts an in-memory MongoDB replica set,
 * seeds the platform and the demo school, and serves the API on PORT (default 4000). Data is gone when it stops.
 */
process.env.APP_ENV = process.env.APP_ENV ?? 'local';
process.env.PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? 'localhost';
process.env.WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
// The dev stack never touches real services, whatever keys .env holds: texts and emails print here, files stay on disk,
// and the test payment page stands in for Paystack. The demo school's numbers are made up and must never be texted.
for (const k of ['PAYSTACK_SECRET_KEY', 'PAYSTACK_PUBLIC_KEY', 'TERMII_API_KEY', 'EMAIL_API_KEY', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'SENTRY_DSN']) process.env[k] = '';
// The dev stack always uses these, whatever .env says, so the demo logins in the README work every time.
process.env.SUPER_ADMIN_PHONE = '+2349000000001';
process.env.SUPER_ADMIN_PASSWORD = 'Demo-Pass-2026!';
for (const k of ['JWT_ACCESS_SECRET', 'JWT_SUPPORT_SECRET', 'COOKIE_SECRET', 'REVALIDATE_SECRET']) process.env[k] = process.env[k] ?? `dev-${k.toLowerCase()}-not-for-production-0123456789`;

async function main() {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 90000 }] });
  process.env.MONGODB_URI = repl.getUri();
  const { env } = require('../config/env');
  const { connectDb, syncIndexes } = require('../core/db');
  require('../models');
  require('../jobs/register');
  const { createApp } = require('../app');
  const { seedPlatformPresets } = require('../seed/presets');
  const { seedSuperAdmin } = require('../seed');
  const { seedDemoSchool, DEMO_PASSWORD } = require('../seed/demo');

  await connectDb(repl.getUri());
  await syncIndexes();
  await seedPlatformPresets();
  await seedSuperAdmin();
  const demo = await seedDemoSchool({ students: Number(process.env.DEMO_STUDENTS ?? 120) });
  const server = createApp().listen(env.PORT, () => {
     
    console.log(`\nAPI on http://localhost:${env.PORT}\nDemo school ready (${demo.students} students). Open http://demo.localhost:3000/app/login\nSuper admin +2349000000001 (code printed here)  Owner ${demo.owner}  Bursar ${demo.bursar}  Parent ${demo.sharedParent}\nPassword ${DEMO_PASSWORD}\n`);
  });
  server.on('error', async (e: any) => {
     
    console.error(e.code === 'EADDRINUSE' ? `\nPort ${env.PORT} is already in use. Stop the other API (or set PORT=4001) and run this again.\n` : e);
    await repl.stop();
    process.exit(1);
  });
  const stop = async () => { await repl.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
