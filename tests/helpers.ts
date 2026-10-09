import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { connectDb, disconnectDb, syncIndexes } from '../src/core/db';
import { asPlatform, emptyCtx, forSchool, runWithCtx } from '../src/core/context';
import { drainJobs } from '../src/jobs/queue';
import { clearHostCache } from '../src/core/host';
import { limiter, resetLimits } from '../src/core/rateLimit';
import { clearOutbox, lastCodeFor, outbox } from '../src/integrations/sms';
import { fakePaystack } from '../src/integrations/paystack';
import { hashPassword } from '../src/lib/passwords';
import '../src/models';
import '../src/jobs/register';
import { Guardian, Membership, School, Staff, Student, StudentGuardian, User } from '../src/models';

export let repl: MongoMemoryReplSet;
let app: Express;
export const getApp = () => app;

export async function startTestDb() {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 90000 }] });
  await connectDb(repl.getUri());
  await syncIndexes();
  app = createApp();
}

export async function stopTestDb() {
  await drainJobs();
  await disconnectDb();
  await repl?.stop();
}

/** Empty every collection between tests. Indexes stay. */
export async function resetDb() {
  await drainJobs();
  const cols = await mongoose.connection.db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
  clearOutbox();
  clearHostCache();
  resetLimits();
  limiter.enabled = false;
  fakePaystack.txns.clear();
  fakePaystack.refunds.length = 0;
}

export const ctxFor = <T>(schoolId: string, fn: () => T | PromiseLike<T>) => runWithCtx(emptyCtx(), () => forSchool(schoolId, fn));
export const platform = <T>(fn: () => T | PromiseLike<T>) => runWithCtx(emptyCtx(), () => asPlatform(fn));

/** supertest with the header every state-changing request must carry. A cookie jar keeps the session. */
export function client(host?: string) {
  const agent = request.agent(app);
  const wrap = (method: 'get' | 'post' | 'put' | 'patch' | 'delete') => (path: string) => {
    let r = (agent as any)[method](`/api/v1${path}`).set('X-Requested-With', 'fetch');
    if (host) r = r.set('Host', host);
    return r;
  };
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete'), agent };
}
export type Client = ReturnType<typeof client>;

let seq = 0;
const nextPhone = () => `+23480${String(30000000 + ++seq).padStart(8, '0')}`;

export const PASSWORD = 'Correct-Horse-9';

export async function makeSchool(over: Record<string, unknown> = {}) {
  const n = ++seq;
  return platform(() =>
    School.create({
      name: `Test School ${n}`,
      slug: `test-school-${n}`,
      types: ['primary'],
      status: 'active',
      address: { town: 'Ikeja', lga: 'Ikeja', state: 'Lagos' },
      phone: nextPhone(),
      email: `school${n}@example.com`,
      settings: { receiptPrefix: 'TST', admissionNumberFormat: 'TST/{YY}/{SEQ:4}' },
      ...over
    })
  );
}

export async function makeUser(over: Record<string, unknown> = {}, password = PASSWORD) {
  return platform(async () =>
    User.create({ firstName: 'Test', lastName: 'User', phone: nextPhone(), passwordHash: await hashPassword(password), ...over })
  );
}

/** A staff member with a login and a membership in a school. */
export async function makeStaff(school: { _id: unknown }, roles: string[], over: Record<string, unknown> = {}) {
  const schoolId = String(school._id);
  const user = await makeUser({ firstName: roles[0], lastName: 'Staff', ...(over.user as object) });
  const staff = await ctxFor(schoolId, () =>
    Staff.create({ userId: user._id, firstName: user.firstName, lastName: user.lastName, phone: user.phone, roles, status: 'active', ...(over.staff as object) })
  );
  const membership = await platform(() => Membership.create({ userId: user._id, schoolId, kind: 'staff', roles, staffId: staff._id, status: 'active', ...(over.membership as object) }));
  return { user, staff, membership, phone: user.phone as string, password: PASSWORD, schoolId };
}

export async function makeGuardianWithChild(school: { _id: unknown }, opts: { arm?: unknown; admissionNumber?: string; child?: Record<string, unknown> } = {}) {
  const schoolId = String(school._id);
  const user = await makeUser({ firstName: 'Ngozi', lastName: 'Parent' });
  const out = await ctxFor(schoolId, async () => {
    const guardian = await Guardian.create({ userId: user._id, firstName: 'Ngozi', lastName: 'Parent', phone: user.phone });
    const student = await Student.create({ admissionNumber: opts.admissionNumber ?? `TST/26/${String(++seq).padStart(4, '0')}`, firstName: 'Chika', lastName: 'Parent', dob: '2015-03-04', gender: 'female', ...(opts.child ?? {}) });
    await StudentGuardian.create({ studentId: student._id, guardianId: guardian._id, isPrimary: true, isFeePayer: true, relationship: 'mother' });
    return { guardian, student };
  });
  const membership = await platform(() => Membership.create({ userId: user._id, schoolId, kind: 'guardian', guardianId: out.guardian._id, status: 'active', roles: [] }));
  return { user, ...out, membership, phone: user.phone as string, password: PASSWORD, schoolId };
}

export async function loginAs(c: Client, identifier: string, password = PASSWORD) {
  const res = await c.post('/auth/login').send({ identifier, password });
  return res;
}

/** Sign in and return a ready client. */
export async function signIn(identifier: string, host?: string, password = PASSWORD) {
  const c = client(host);
  const res = await loginAs(c, identifier, password);
  if (res.status !== 200) throw new Error(`Sign in failed for ${identifier}: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.data.next === 'choose_membership') throw new Error('Sign in needs a membership choice');
  return { c, res };
}

export const lastCode = lastCodeFor;
export { drainJobs };

/** The super admin signs in on the admin host with the SMS code (two-step is required). */
export async function signInSuperAdmin() {
  const sa = await makeUser({ firstName: 'Super', lastName: 'Admin', platformRole: 'super_admin' });
  const c = client('admin.yourplatform.ng');
  const res = await loginAs(c, sa.phone);
  const done = await c.post('/auth/two-step').send({ challengeId: res.body.data.challengeId, code: lastCodeFor(sa.phone)! });
  if (done.status !== 200) throw new Error(`Super admin sign in failed: ${JSON.stringify(done.body)}`);
  return { c, sa };
}

export const hostOf = (school: { slug: string }) => `${school.slug}.yourplatform.ng`;

/** Jobs run in the background. Wait for them, then read what was sent. */
export async function smsTo(phone: string, match?: RegExp) {
  await drainJobs();
  return [...outbox].reverse().find((o) => o.channel === 'sms' && o.to === phone && (!match || match.test(o.body)));
}
