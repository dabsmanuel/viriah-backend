import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateSync } from 'otplib';
import { client, ctxFor, lastCode, loginAs, makeGuardianWithChild, makeSchool, makeStaff, makeUser, PASSWORD, platform, resetDb, signIn, startTestDb, stopTestDb } from './helpers';
import { limiter } from '../src/core/rateLimit';
import { AuditLog, AuthSession, Guardian, Membership, Student, User } from '../src/models';
import { runWithCtx, emptyCtx } from '../src/core/context';
import { hashPassword } from '../src/lib/passwords';
import { lastSmsTo } from '../src/integrations/sms';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(resetDb);

describe('M1 sign in', () => {
  it('signs in by phone and by email, and /auth/me lists permission keys', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['school_admin'], { user: { email: 'admin@example.com' } });

    const byPhone = await signIn(t.phone);
    expect(byPhone.res.body.data.next).toBe('home');
    const me = await byPhone.c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.permissions).toContain('students.profile.manage');
    expect(me.body.data.permissions).not.toContain('fees.payment.record');

    const byEmail = await signIn('ADMIN@example.com');
    expect(byEmail.res.status).toBe(200);
  });

  it('signs a seeded student in by admission number on the school address', async () => {
    const school = await makeSchool();
    const user = await makeUser({ firstName: 'Ada', lastName: 'Okoye', phone: undefined });
    await ctxFor(String(school._id), () => Student.create({ admissionNumber: 'TST/26/0001', firstName: 'Ada', lastName: 'Okoye', dob: '2014-01-01', userId: user._id }));
    await platform(() => Membership.create({ userId: user._id, schoolId: school._id, kind: 'student', roles: [], status: 'active' }));

    const res = await loginAs(client(`${school.slug}.yourplatform.ng`), 'tst/26/0001');
    expect(res.status).toBe(200);
    expect(res.body.data.membership.roles).toEqual(['student']);
    // the same number does nothing on the platform host
    const other = await loginAs(client('yourplatform.ng'), 'TST/26/0001');
    expect(other.status).toBe(401);
  });

  it('gives one error for a wrong login and a wrong password', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['bursar']);
    const wrongPassword = await loginAs(client(), t.phone, 'nope-nope-nope');
    const unknown = await loginAs(client(), '08099999999', 'nope-nope-nope');
    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account for 15 minutes after five wrong passwords', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['bursar']);
    for (let i = 0; i < 5; i++) expect((await loginAs(client(), t.phone, 'wrong-pass-1')).status).toBe(401);
    const locked = await loginAs(client(), t.phone, PASSWORD); // even the right password is refused
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    const u = await platform(() => User.findById(t.user._id).lean());
    expect(u.lockedUntil.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // after the lock passes the user can sign in again
    await platform(() => User.updateOne({ _id: t.user._id }, { lockedUntil: new Date(Date.now() - 1000) }));
    expect((await loginAs(client(), t.phone)).status).toBe(200);
  });

  it('refuses a deactivated user', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['bursar']);
    await platform(() => User.updateOne({ _id: t.user._id }, { status: 'deactivated' }));
    expect((await loginAs(client(), t.phone)).status).toBe(401);
  });

  it('rate limits login attempts when limits are on', async () => {
    limiter.enabled = true;
    const school = await makeSchool();
    const t = await makeStaff(school, ['bursar']);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await loginAs(client(), t.phone, 'wrong-pass-1')).status;
    expect(last).toBe(429);
  });
});

describe('M1 sessions and tokens', () => {
  it('rotates the refresh token and revokes the whole chain when an old one is reused', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['principal']);
    const login = await client().post('/auth/login').set('x-return-tokens', '1').send({ identifier: t.phone, password: PASSWORD });
    const first = login.body.data.tokens.refresh as string;

    const a = client();
    const r1 = await a.post('/auth/refresh').send({ refreshToken: first });
    expect(r1.status).toBe(200);
    const cookies = (r1.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookies).toContain('vr_rt=');
    expect(cookies).toContain('HttpOnly');

    // the old token is now stale. Using it again is reuse: the whole chain dies.
    const reuse = await client().post('/auth/refresh').send({ refreshToken: first });
    expect(reuse.status).toBe(401);
    const current = a.agent; // the rotated token no longer works either
    const afterReuse = await current.post('/api/v1/auth/refresh').set('X-Requested-With', 'fetch').send({});
    expect(afterReuse.status).toBe(401);
    const me = await a.get('/auth/me');
    expect(me.status).toBe(401);
  });

  it('logs out and out of all devices', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['principal']);
    const one = (await signIn(t.phone)).c;
    const two = (await signIn(t.phone)).c;
    expect((await one.get('/auth/sessions')).body.data.length).toBe(2);
    expect((await one.post('/auth/logout-all').send({})).status).toBe(204);
    expect((await one.get('/auth/me')).status).toBe(401);
    expect((await two.get('/auth/me')).status).toBe(401);
  });

  it('requires the X-Requested-With header on every state-changing request', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['principal']);
    const res = await client().agent.post('/api/v1/auth/login').send({ identifier: t.phone, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it('refuses a token for a user whose session was revoked, without waiting for expiry', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['principal']);
    const { c } = await signIn(t.phone);
    await platform(() => AuthSession.updateMany({ userId: t.user._id }, { revokedAt: new Date() }));
    expect((await c.get('/auth/me')).status).toBe(401);
  });
});

describe('M1 passwords', () => {
  it('resets by SMS code and ends the user’s other sessions', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['bursar']);
    const other = (await signIn(t.phone)).c;

    const asker = client();
    expect((await asker.post('/auth/forgot-password').send({ identifier: t.phone })).status).toBe(200);
    const code = lastCode(t.phone)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(lastSmsTo(t.phone)!.body).toContain(code);

    const bad = await asker.post('/auth/reset-password').send({ identifier: t.phone, code: '000000', newPassword: 'Brand-New-Pass-77' });
    expect(bad.status).toBe(422);
    const res = await asker.post('/auth/reset-password').send({ identifier: t.phone, code, newPassword: 'Brand-New-Pass-77' });
    expect(res.status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(401); // other sessions ended
    expect((await loginAs(client(), t.phone, 'Brand-New-Pass-77')).status).toBe(200);
    expect((await loginAs(client(), t.phone, PASSWORD)).status).toBe(401);
    // the code only works once
    expect((await asker.post('/auth/reset-password').send({ identifier: t.phone, code, newPassword: 'Another-Pass-88' })).status).toBe(422);
    const logged = await platform(() => AuditLog.find({ action: 'auth.password.reset' }).lean());
    expect(logged.length).toBe(1);
  });

  it('does not reveal whether an account exists', async () => {
    const res = await client().post('/auth/forgot-password').send({ identifier: '08000000000' });
    expect(res.status).toBe(200);
  });

  it('allows only five attempts at a code', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['bursar']);
    const c = client();
    await c.post('/auth/forgot-password').send({ identifier: t.phone });
    const code = lastCode(t.phone)!;
    for (let i = 0; i < 5; i++) await c.post('/auth/reset-password').send({ identifier: t.phone, code: '999999', newPassword: 'Brand-New-Pass-77' });
    const res = await c.post('/auth/reset-password').send({ identifier: t.phone, code, newPassword: 'Brand-New-Pass-77' });
    expect(res.status).toBe(422);
  });

  it('forces a change of a temporary password before anything else can be done', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['bursar']);
    await platform(() => User.updateOne({ _id: t.user._id }, { mustChangePassword: true }));
    const { c, res } = await signIn(t.phone);
    expect(res.body.data.next).toBe('change_password');
    const blocked = await c.get('/students');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details.mustChangePassword).toBe(true);
    expect((await c.get('/auth/me')).status).toBe(200);

    const weak = await c.post('/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'password123' });
    expect(weak.status).toBe(422);
    const changed = await c.post('/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'Fresh-Pass-4242' });
    expect(changed.status).toBe(200);
    expect((await c.get('/students')).status).toBe(200);
    expect((await platform(() => User.findById(t.user._id).lean())).mustChangePassword).toBe(false);
  });

  it('sends a student’s reset code to the main guardian when the student has no phone', async () => {
    const school = await makeSchool();
    const parent = await makeGuardianWithChild(school, { admissionNumber: 'TST/26/0777' });
    const studentUser = await makeUser({ firstName: 'Chika', phone: undefined });
    await ctxFor(String(school._id), () => Student.updateOne({ _id: parent.student._id }, { userId: studentUser._id }));
    await platform(() => Membership.create({ userId: studentUser._id, schoolId: school._id, kind: 'student', studentId: parent.student._id, roles: [], status: 'active' }));

    const host = `${school.slug}.yourplatform.ng`;
    await client(host).post('/auth/forgot-password').send({ identifier: 'TST/26/0777' });
    expect(lastCode(parent.phone)).toMatch(/^\d{6}$/);
  });
});

describe('M1 two-step and the super admin', () => {
  it('does not let the super admin finish signing in without a two-step code', async () => {
    const sa = await makeUser({ firstName: 'Super', lastName: 'Admin', platformRole: 'super_admin' });
    const c = client('admin.yourplatform.ng');
    const res = await loginAs(c, sa.phone);
    expect(res.status).toBe(200);
    expect(res.body.data.next).toBe('two_step');
    expect(res.body.data.method).toBe('sms');
    expect((await c.get('/platform/schools')).status).toBe(401); // no session yet

    const wrong = await c.post('/auth/two-step').send({ challengeId: res.body.data.challengeId, code: '111111' });
    expect(wrong.status).toBe(401);
    const done = await c.post('/auth/two-step').send({ challengeId: res.body.data.challengeId, code: lastCode(sa.phone)! });
    expect(done.status).toBe(200);
    expect(done.body.data.portal).toBe('admin');
    expect((await c.get('/platform/schools')).status).toBe(200);
    // the console asks /auth/me who is signed in: it must say a platform user, with platform permissions (this was once null and looped the sign-in)
    const me = await c.get('/auth/me');
    expect(me.body.data.current.kind).toBe('platform');
    expect(me.body.data.permissions).toContain('platform.schools.manage');
    // the challenge cannot be reused
    expect((await c.post('/auth/two-step').send({ challengeId: res.body.data.challengeId, code: lastCode(sa.phone)! })).status).toBe(401);
  });

  it('cannot switch two-step off for the super admin', async () => {
    const sa = await makeUser({ firstName: 'Super', platformRole: 'super_admin' });
    const c = client('admin.yourplatform.ng');
    const res = await loginAs(c, sa.phone);
    await c.post('/auth/two-step').send({ challengeId: res.body.data.challengeId, code: lastCode(sa.phone)! });
    expect((await c.post('/auth/confirm-password').send({ password: PASSWORD })).status).toBe(200);
    const off = await c.delete('/auth/two-step');
    expect(off.status).toBe(403);
  });

  it('sets up an authenticator app, signs in with a code, and accepts a recovery code once', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['principal']);
    const { c } = await signIn(t.phone);
    const setup = await c.post('/auth/two-step/setup').send({ method: 'totp' });
    expect(setup.status).toBe(200);
    const secret = setup.body.data.secret as string;
    const confirm = await c.post('/auth/two-step/confirm').send({ code: generateSync({ secret }) });
    expect(confirm.status).toBe(200);
    const recovery = confirm.body.data.recoveryCodes as string[];
    expect(recovery.length).toBe(8);

    const login = await loginAs(client(), t.phone);
    expect(login.body.data).toMatchObject({ next: 'two_step', method: 'totp' });
    const fresh = client();
    const l2 = await loginAs(fresh, t.phone);
    expect((await fresh.post('/auth/two-step').send({ challengeId: l2.body.data.challengeId, code: generateSync({ secret }) })).status).toBe(200);

    const l3 = await loginAs(client(), t.phone);
    const c3 = client();
    const l4 = await loginAs(c3, t.phone);
    expect((await c3.post('/auth/two-step').send({ challengeId: l4.body.data.challengeId, code: recovery[0] })).status).toBe(200);
    const c4 = client();
    const l5 = await loginAs(c4, t.phone);
    expect((await c4.post('/auth/two-step').send({ challengeId: l5.body.data.challengeId, code: recovery[0] })).status).toBe(401); // used once
    void l3;
  });
});

describe('M1 memberships', () => {
  it('gives a chooser to a user with two memberships, and switching changes the school in the token', async () => {
    const a = await makeSchool({ name: 'Alpha School' });
    const b = await makeSchool({ name: 'Beta School' });
    const t = await makeStaff(a, ['subject_teacher']);
    await platform(() => Membership.create({ userId: t.user._id, schoolId: b._id, kind: 'staff', roles: ['class_teacher'], status: 'active' }));

    const c = client();
    const res = await loginAs(c, t.phone);
    expect(res.body.data.next).toBe('choose_membership');
    expect(res.body.data.memberships.map((m: any) => m.school).sort()).toEqual(['Alpha School', 'Beta School']);
    // before choosing, no school data is reachable
    expect((await c.get('/students')).status).toBe(403);

    const pick = res.body.data.memberships.find((m: any) => m.school === 'Beta School');
    const sw = await c.post('/auth/switch').send({ membershipId: pick.id });
    expect(sw.status).toBe(200);
    const me = await c.get('/auth/me');
    expect(me.body.data.school.name).toBe('Beta School');
    expect(me.body.data.current.roles).toEqual(['class_teacher']);

    const other = res.body.data.memberships.find((m: any) => m.school === 'Alpha School');
    const back = await c.post('/auth/switch').send({ membershipId: other.id });
    expect(back.status).toBe(200);
    expect((await c.get('/auth/me')).body.data.school.name).toBe('Alpha School');
  });

  it('refuses to switch to someone else’s membership', async () => {
    const school = await makeSchool();
    const a = await makeStaff(school, ['principal']);
    const b = await makeStaff(school, ['bursar']);
    const { c } = await signIn(a.phone);
    expect((await c.post('/auth/switch').send({ membershipId: String(b.membership._id) })).status).toBe(404);
  });

  it('a teacher who is also a parent gets two memberships in one school', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['subject_teacher']);
    const g = await ctxFor(String(school._id), () => Guardian.create({ userId: t.user._id, firstName: 'T', lastName: 'Staff', phone: t.phone }));
    await platform(() => Membership.create({ userId: t.user._id, schoolId: school._id, kind: 'guardian', guardianId: g._id, roles: [], status: 'active' }));
    const res = await loginAs(client(), t.phone);
    expect(res.body.data.next).toBe('choose_membership');
    expect(res.body.data.memberships.map((m: any) => m.roles[0]).sort()).toEqual(['parent', 'subject_teacher']);
  });

  it('ends a session when the membership is deactivated or its roles change', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['bursar']);
    const { c } = await signIn(t.phone);
    expect((await c.get('/auth/me')).status).toBe(200);
    await platform(() => Membership.updateOne({ _id: t.membership._id }, { $inc: { permVersion: 1 } }));
    expect((await c.get('/auth/me')).status).toBe(401);
    // refreshing picks up the new version
    expect((await c.post('/auth/refresh').send({})).status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(200);
    await platform(() => Membership.updateOne({ _id: t.membership._id }, { status: 'deactivated' }));
    expect((await c.post('/auth/refresh').send({})).status).toBe(401);
  });
});

describe('M1 audit and tenancy plumbing', () => {
  it('writes an audit record for sign in and has no way to edit or delete one', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['principal']);
    await signIn(t.phone);
    const rec = await platform(() => AuditLog.findOne({ action: 'auth.login' }));
    expect(rec).toBeTruthy();
    expect(String(rec.schoolId)).toBe(String(school._id));
    await expect(platform(() => AuditLog.updateOne({ _id: rec._id }, { action: 'x' }))).rejects.toThrow(/append only/);
    await expect(platform(() => AuditLog.deleteMany({}))).rejects.toThrow(/append only/);
    rec.action = 'changed';
    await expect(rec.save()).rejects.toThrow(/append only/);
  });

  it('throws when a tenant model is queried with no school in context', async () => {
    await expect(Student.find({})).rejects.toThrow(/no request context/i);
    await expect(runWithCtx(emptyCtx(), async () => await Student.find({}))).rejects.toThrow(/no school in context/i);
  });

  it('scopes every tenant query to the school in context, and refuses a cross-school write', async () => {
    const a = await makeSchool();
    const b = await makeSchool();
    await ctxFor(String(a._id), () => Student.create({ admissionNumber: 'A/1', firstName: 'A', lastName: 'One', dob: '2015-01-01' }));
    await ctxFor(String(b._id), () => Student.create({ admissionNumber: 'B/1', firstName: 'B', lastName: 'One', dob: '2015-01-01' }));
    expect((await ctxFor(String(a._id), () => Student.find({}))).map((s: any) => s.admissionNumber)).toEqual(['A/1']);
    expect(await ctxFor(String(a._id), () => Student.countDocuments({}))).toBe(1);
    expect(await ctxFor(String(a._id), () => Student.findOne({ admissionNumber: 'B/1' }))).toBeNull();
    expect((await ctxFor(String(a._id), () => Student.aggregate([{ $match: {} }]))).length).toBe(1);
    expect((await ctxFor(String(a._id), () => Student.updateMany({}, { lastName: 'Changed' }))).modifiedCount).toBe(1);
    expect((await ctxFor(String(b._id), () => Student.findOne({}))).lastName).toBe('One');
    await expect(
      ctxFor(String(a._id), () => Student.create({ schoolId: b._id, admissionNumber: 'X', firstName: 'X', lastName: 'X', dob: '2015-01-01' }))
    ).rejects.toThrow(/Cross-school/);
  });

  it('seeds a password hash that verifies (sanity)', async () => {
    const h = await hashPassword('abc');
    expect(h.startsWith('$argon2id$')).toBe(true);
  });
});
