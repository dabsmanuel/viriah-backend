import { env } from '../config/env';
import { asPlatform } from '../core/context';
import { connectDb, disconnectDb, syncIndexes } from '../core/db';
import { hashPassword } from '../lib/passwords';
import { normalizePhone } from '../lib/phone';
import { User } from '../models';
import { seedPlatformPresets } from './presets';
import { seedDemoSchool, DEMO_PASSWORD } from './demo';

/**
 * npm run seed:platform   presets, the first super admin, template version 1 (safe to run on every deploy)
 * npm run seed:demo       the demo school (recreated from scratch each time)
 */

export async function seedSuperAdmin() {
  const phone = normalizePhone(env.SUPER_ADMIN_PHONE)!;
  const existing = await asPlatform(() => User.findOne({ phone }).select('_id').lean());
  if (existing) return { created: false, phone };
  await asPlatform(async () =>
    User.create({ firstName: 'Platform', lastName: 'Admin', phone, email: env.SUPER_ADMIN_EMAIL, passwordHash: await hashPassword(env.SUPER_ADMIN_PASSWORD), platformRole: 'super_admin', mustChangePassword: env.APP_ENV === 'production', phoneVerifiedAt: new Date() })
  );
  return { created: true, phone };
}

async function main() {
  const what = process.argv[2] ?? 'platform';
  await connectDb();
  await syncIndexes();
  if (what === 'platform' || what === 'demo') {
    await seedPlatformPresets();
    const sa = await seedSuperAdmin();
     
    console.log(`Platform presets ready. Super admin ${sa.created ? 'created' : 'already exists'}: ${sa.phone} (two-step code by SMS).`);
  }
  if (what === 'demo') {
    if (env.APP_ENV === 'production') throw new Error('The demo school is never created in production.');
    const out = await seedDemoSchool();
     
    console.log(`Demo school ready at slug "demo": ${out.students} students. Sign in as ${out.owner} with ${DEMO_PASSWORD}.`);
  }
  await disconnectDb();
}

if (require.main === module) {
  main().catch((e) => {
     
    console.error(e);
    process.exit(1);
  });
}
