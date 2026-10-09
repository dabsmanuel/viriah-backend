import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, platform, resetDb, startTestDb, stopTestDb, client, signIn } from './helpers';
import { seedDemoSchool, DEMO_PASSWORD } from '../src/seed/demo';
import { seedSuperAdmin } from '../src/seed';
import { Application, Credit, Guardian, Invoice, Payment, School, Staff, Student, Task } from '../src/models';
import { drainJobs } from '../src/jobs/queue';

beforeAll(startTestDb);
afterAll(stopTestDb);

describe('seed', () => {
  it('creates the demo school with one command, and again without duplicating anything', async () => {
    await resetDb();
    const out = await seedDemoSchool({ students: 60 });
    await drainJobs();
    const school: any = await platform(() => School.findOne({ slug: 'demo' }).lean());
    expect(school.name).toBe('Greenfield Demo Schools');
    const sid = String(school._id);
    const count = (M: any, f: any = {}) => ctxFor(sid, () => M.countDocuments(f));
    expect(await count(Staff)).toBe(15); // owner/principal, admin, bursar, twelve teachers
    expect(await count(Student)).toBeGreaterThanOrEqual(60);
    expect(await count(Guardian)).toBeGreaterThan(30);
    expect(await count(Task)).toBe(6);
    expect(await count(Application)).toBe(11); // one in every status
    expect(await count(Payment, { status: 'pending_confirmation' })).toBe(1);
    expect(await count(Payment, { status: 'reversed' })).toBe(1);
    expect(await count(Credit)).toBeGreaterThanOrEqual(1);
    expect(await count(Invoice, { kind: 'opening_balance' })).toBeGreaterThanOrEqual(1);
    expect(await count(Invoice, { 'discounts.0': { $exists: true } })).toBeGreaterThanOrEqual(1);
    expect(await count(Student, { status: 'withdrawn' })).toBe(1);
    // a second small school shares one parent with the first
    const second: any = await platform(() => School.findOne({ slug: 'riverside' }).lean());
    expect(second.branding.primary).not.toBe(school.branding.primary);

    // the owner signs in with the documented password
    const owner = await signIn(out.owner, 'demo.yourplatform.ng', DEMO_PASSWORD);
    expect((await owner.c.get('/auth/me')).body.data.school.name).toBe('Greenfield Demo Schools');
    // the shared parent gets a chooser for the two schools
    const shared = client('yourplatform.ng');
    const res = await shared.post('/auth/login').send({ identifier: out.sharedParent, password: DEMO_PASSWORD });
    expect(res.body.data.next).toBe('choose_membership');
    expect(res.body.data.memberships.length).toBe(2);

    // recreated from scratch: the same counts, no duplicates
    await seedDemoSchool({ students: 60 });
    const again: any = await platform(() => School.find({ slug: 'demo' }).lean());
    expect(again.length).toBe(1);
    expect(await ctxFor(String(again[0]._id), () => Task.countDocuments({}))).toBe(6);
    expect(await platform(() => School.countDocuments({ slug: 'riverside' }))).toBe(1);
  }, 280_000);

  it('seeds the first super admin once', async () => {
    await resetDb();
    expect((await seedSuperAdmin()).created).toBe(true);
    expect((await seedSuperAdmin()).created).toBe(false);
  });
});
