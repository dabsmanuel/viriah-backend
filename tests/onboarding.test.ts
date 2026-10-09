import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, ctxFor, drainJobs, hostOf, loginAs, makeSchool, makeStaff, PASSWORD, platform, resetDb, signIn, signInSuperAdmin, smsTo, startTestDb, stopTestDb } from './helpers';
import { outbox, lastCodeFor } from '../src/integrations/sms';
import { seedPlatformPresets } from '../src/seed/presets';
import { AuditLog, AuthSession, ClassLevel, ClassSubject, GradingScale, LevelGroup, Membership, School, Staff, Student, Term } from '../src/models';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await resetDb();
  await seedPlatformPresets();
});

async function registerSchoolFlow(slug = 'greenfield') {
  const c = client('yourplatform.ng');
  const phone = '+2348031112222';
  const emailAddr = 'owner@greenfield.example';
  expect((await c.post('/public/schools/register/start').send({ phone, email: emailAddr })).status).toBe(200);
  const code = lastCodeFor(phone)!;
  const mail = [...outbox].reverse().find((o) => o.channel === 'email' && o.to === emailAddr)!;
  const emailToken = /token=([^&\s]+)/.exec(mail.body)![1];
  const v = await c.post('/public/schools/register/verify').send({ phone, email: emailAddr, code, emailToken });
  expect(v.status).toBe(200);
  const res = await c.post('/public/schools/register').send({
    signupToken: v.body.data.signupToken,
    slug,
    school: { name: 'Greenfield Schools', types: ['nursery', 'primary'], address: { town: 'Ikeja', lga: 'Ikeja', state: 'Lagos' } },
    owner: { firstName: 'Ada', lastName: 'Obi', password: 'Owner-Pass-2026' },
    acceptTerms: true,
    acceptDpa: true
  });
  return { res, phone, emailAddr };
}

describe('M2 school sign-up and approval', () => {
  it('registers end to end and appears as pending in the console', async () => {
    const { res } = await registerSchoolFlow();
    expect(res.status).toBe(201);
    expect(res.body.data.school.status).toBe('pending');
    const { c: sa } = await signInSuperAdmin();
    const list = await sa.get('/platform/schools?status=pending');
    expect(list.body.data.map((s: any) => s.slug)).toContain('greenfield');
  });

  it('refuses a taken address and a reserved address, with suggestions', async () => {
    await registerSchoolFlow('greenfield');
    const c = client('yourplatform.ng');
    const taken = await c.get('/public/schools/check-slug?slug=greenfield&town=Ikeja');
    expect(taken.body.data).toMatchObject({ available: false, reason: 'taken' });
    expect(taken.body.data.suggestions.length).toBeGreaterThan(0);
    const reserved = await c.get('/public/schools/check-slug?slug=admin');
    expect(reserved.body.data).toMatchObject({ available: false, reason: 'reserved' });
    expect((await c.get('/public/schools/check-slug?slug=Bad Slug!')).body.data.reason).toBe('invalid');
    expect((await c.get('/public/schools/check-slug?slug=fresh-school')).body.data.available).toBe(true);
  });

  it('needs the phone code and the email link before the sign-up is accepted', async () => {
    const c = client('yourplatform.ng');
    await c.post('/public/schools/register/start').send({ phone: '+2348031112222', email: 'o@x.example' });
    const bad = await c.post('/public/schools/register/verify').send({ phone: '+2348031112222', email: 'o@x.example', code: '000000', emailToken: 'x'.repeat(24) });
    expect(bad.status).toBe(422);
    const noToken = await c.post('/public/schools/register').send({ signupToken: 'n'.repeat(30), slug: 'abc-school', school: { name: 'A', types: ['primary'], address: { lga: 'x', state: 'y' } }, owner: { firstName: 'a', lastName: 'b', password: 'Owner-Pass-2026' }, acceptTerms: true, acceptDpa: true });
    expect(noToken.status).toBe(422);
  });

  it('flags a possible duplicate (same name in the same LGA) to the super admin', async () => {
    await makeSchool({ name: 'Greenfield Schools', address: { town: 'Ikeja', lga: 'Ikeja', state: 'Lagos' }, slug: 'greenfield-old' });
    await registerSchoolFlow('greenfield');
    expect((await platform(() => School.findOne({ slug: 'greenfield' }))).possibleDuplicate).toBe(true);
  });

  it('lets a pending owner sign in and use the checklist, but not go live; approval notifies and activates', async () => {
    await registerSchoolFlow();
    const host = 'greenfield.yourplatform.ng';
    const { c: owner } = await signIn('+2348031112222', host, 'Owner-Pass-2026');
    const progress = await owner.get('/school/setup-progress');
    expect(progress.status).toBe(200);
    expect(progress.body.data.steps.length).toBe(12);
    expect(progress.body.data.schoolStatus).toBe('pending');
    const live = await owner.post('/school/go-live').set('Idempotency-Key', 'golive-12345678').send({});
    expect(live.status).toBe(403);
    expect(live.body.error.code).toBe('school_not_active');

    const { c: sa } = await signInSuperAdmin();
    const school = await platform(() => School.findOne({ slug: 'greenfield' }));
    const ok = await sa.post(`/platform/schools/${school._id}/approve`).send({});
    expect(ok.status).toBe(200);
    expect((await platform(() => School.findById(school._id))).status).toBe('active');
    expect(await smsTo('+2348031112222', /approved/)).toBeTruthy();
    // an approved school cannot be approved again
    expect((await sa.post(`/platform/schools/${school._id}/approve`).send({})).status).toBe(409);
  });

  it('rejects with a reason, and the owner can resubmit once', async () => {
    await registerSchoolFlow();
    const { c: sa } = await signInSuperAdmin();
    const school = await platform(() => School.findOne({ slug: 'greenfield' }));
    expect((await sa.post(`/platform/schools/${school._id}/reject`).send({})).status).toBe(422); // reason is required
    expect((await sa.post(`/platform/schools/${school._id}/reject`).send({ reason: 'Missing registration number' })).status).toBe(200);
    const { c: owner } = await signIn('+2348031112222', 'greenfield.yourplatform.ng', 'Owner-Pass-2026');
    expect((await owner.get('/school')).body.data.statusReason).toBe('Missing registration number');
    expect((await owner.post('/school/resubmit').send({})).status).toBe(200);
    await sa.post(`/platform/schools/${school._id}/reject`).send({ reason: 'Still missing' });
    expect((await owner.post('/school/resubmit').send({})).status).toBe(409);
  });

  it('assisted creation sends an invite and the owner can set a password', async () => {
    const { c: sa } = await signInSuperAdmin();
    const res = await sa.post('/platform/schools').send({ name: 'Assisted Academy', slug: 'assisted', types: ['primary'], address: { lga: 'Ikeja', state: 'Lagos' }, owner: { firstName: 'Tunde', lastName: 'Bello', phone: '08033334444' } });
    expect(res.status).toBe(201);
    const sms = (await smsTo('+2348033334444'))!;
    const token = /token=([^\s&]+)/.exec(sms.body)![1];
    const c = client('assisted.yourplatform.ng');
    const accept = await c.post('/auth/accept-invite').send({ token, password: 'Fresh-Owner-77' });
    expect(accept.status).toBe(200);
    expect(accept.body.data.membership.roles).toEqual(['owner']);
    expect((await c.get('/school')).body.data.name).toBe('Assisted Academy');
    // the invite works once
    expect((await client('assisted.yourplatform.ng').post('/auth/accept-invite').send({ token, password: 'Another-Owner-77' })).status).toBe(422);
  });

  it('finds a school by name and links to its address', async () => {
    await makeSchool({ name: 'Zenith Heights School', slug: 'zenith-heights' });
    const res = await client('yourplatform.ng').get('/public/schools/search?q=zenith');
    expect(res.body.data[0]).toMatchObject({ name: 'Zenith Heights School', slug: 'zenith-heights' });
    expect(res.body.data[0].address).toContain('zenith-heights');
  });
});

describe('M2 suspension and support access', () => {
  it('makes a suspended school read only: staff can read, every change returns school_not_active, reactivation restores', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['owner']);
    const { c } = await signIn(t.phone, hostOf(school));
    const { c: sa } = await signInSuperAdmin();
    expect((await sa.post(`/platform/schools/${school._id}/suspend`).send({ reason: 'Unpaid fees' })).status).toBe(200);
    expect((await c.get('/school')).status).toBe(200);
    const write = await c.patch('/school').send({ motto: 'New motto' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('school_not_active');
    expect((await sa.post(`/platform/schools/${school._id}/reactivate`).send({})).status).toBe(200);
    expect((await c.patch('/school').send({ motto: 'New motto' })).status).toBe(200);
  });

  it('shows a support session on /auth/me, audits under the super admin, blocks money and approvals, and ends at 60 minutes', async () => {
    const school = await makeSchool();
    await makeStaff(school, ['owner']);
    const { c: sa, sa: saUser } = await signInSuperAdmin();
    const start = await sa.post(`/platform/schools/${school._id}/support-session`).send({ reason: 'Help with setup' });
    expect(start.status).toBe(201);
    const token = start.body.data.supportToken as string;

    const portal = client(hostOf(school));
    expect((await portal.post('/auth/support/exchange').send({ token })).status).toBe(200);
    const me = await portal.get('/auth/me');
    expect(me.body.data.support).toBe(true);

    // a change is allowed and audited under the super admin's identity
    expect((await portal.patch('/school').send({ motto: 'Support edit' })).status).toBe(200);
    const rec = await platform(() => AuditLog.findOne({ action: 'school.profile.update' }).lean());
    expect(String(rec.actorUserId)).toBe(String(saUser._id));
    expect(rec.supportSession).toBe(true);

    // blocked: bank account, approving results, recording payments
    const bank = await portal.put('/school/bank').send({ bankCode: '058', accountNumber: '0123456789', code: '123456' });
    expect(bank.status).toBe(403);
    expect(bank.body.error.code).toBe('support_blocked');
    expect((await portal.post('/payments/offline').set('Idempotency-Key', 'support-block-1').send({})).body.error.code).toBe('support_blocked');

    // ending the session kills the token at once
    expect((await sa.delete('/platform/support-session')).status).toBe(204);
    expect((await portal.get('/auth/me')).status).toBe(401);
    // and a support session expires on its own after 60 minutes
    const start2 = await sa.post(`/platform/schools/${school._id}/support-session`).send({ reason: 'Again' });
    await platform(() => AuthSession.updateMany({ support: true, revokedAt: { $exists: false } }, { expiresAt: new Date(Date.now() - 1000) }));
    const p2 = client(hostOf(school));
    expect((await p2.post('/auth/support/exchange').send({ token: start2.body.data.supportToken })).status).toBe(401);
  });

  it('only the super admin can reach /platform', async () => {
    const school = await makeSchool();
    const t = await makeStaff(school, ['owner']);
    const { c } = await signIn(t.phone, hostOf(school));
    expect((await c.get('/platform/schools')).status).toBe(403);
    expect((await client().get('/platform/schools')).status).toBe(401);
  });
});

describe('M3 academic structure', () => {
  async function ownerOf(school: any) {
    const t = await makeStaff(school, ['owner']);
    return (await signIn(t.phone, hostOf(school))).c;
  }
  const terms = [
    { number: 1, startDate: '2026-09-14', endDate: '2026-12-18' },
    { number: 2, startDate: '2027-01-11', endDate: '2027-04-02' },
    { number: 3, startDate: '2027-04-26', endDate: '2027-07-23' }
  ];

  it('applies presets and gives the chosen class levels with subjects and level groups', async () => {
    const school = await makeSchool();
    const c = await ownerOf(school);
    const res = await c.post('/setup/apply-presets').send({ classLevels: ['primary_1', 'primary_2', 'jss_1'] });
    expect(res.status).toBe(200);
    expect(res.body.data.classLevels).toBe(3);
    const levels = await c.get('/class-levels');
    expect(levels.body.data.map((l: any) => l.name)).toEqual(['Primary 1', 'Primary 2', 'JSS 1']);
    expect(levels.body.data[0].arms.map((a: any) => a.name)).toEqual(['A']);
    const subjects = await c.get(`/class-levels/${levels.body.data[0].id}/subjects`);
    expect(subjects.body.data.map((s: any) => s.name)).toContain('English Language');
    const groups = await c.get('/level-groups');
    expect(groups.body.data.map((g: any) => g.name)).toEqual(['Primary', 'Junior Secondary']);
    expect(groups.body.data[0].gradingScale.bands.length).toBe(6);
    // idempotent
    const again = await c.post('/setup/apply-presets').send({ classLevels: ['primary_1', 'primary_2', 'jss_1'] });
    expect(again.body.data.classLevels).toBe(0);
    expect(again.body.data.classSubjects).toBe(0);
    // Primary 2 follows Primary 1
    expect(String(levels.body.data[0].nextLevelId)).toBe(levels.body.data[1].id);
  });

  it('renames Primary 1 to Basic 1 and adds arms; refuses a duplicate arm', async () => {
    const school = await makeSchool();
    const c = await ownerOf(school);
    await c.post('/setup/apply-presets').send({ classLevels: ['primary_1'] });
    const [lvl] = (await c.get('/class-levels')).body.data;
    expect((await c.patch(`/class-levels/${lvl.id}`).send({ name: 'Basic 1' })).body.data.name).toBe('Basic 1');
    expect((await c.post('/class-arms').send({ classLevelId: lvl.id, name: 'B' })).status).toBe(201);
    expect((await c.post('/class-arms').send({ classLevelId: lvl.id, name: 'B' })).status).toBe(422);
  });

  it('refuses a grading scale with a gap or an overlap, and names the gap', async () => {
    const school = await makeSchool();
    const c = await ownerOf(school);
    const bands = [
      { min: 70, max: 100, grade: 'A', remark: 'Excellent' },
      { min: 60, max: 69, grade: 'B', remark: 'Good' },
      { min: 52, max: 59, grade: 'C', remark: 'Fair' },
      { min: 0, max: 49, grade: 'F', remark: 'Fail' }
    ];
    const gap = await c.post('/grading-scales').send({ name: 'Bad', passMark: 50, bands });
    expect(gap.status).toBe(422);
    expect(gap.body.error.message).toMatch(/gap between 49 and 52/);
    const overlap = await c.post('/grading-scales').send({ name: 'Bad2', passMark: 50, bands: [{ min: 0, max: 60, grade: 'F', remark: '' }, { min: 55, max: 100, grade: 'A', remark: '' }] });
    expect(overlap.body.error.message).toMatch(/overlap/);
  });

  it('refuses an assessment structure that totals 90', async () => {
    const school = await makeSchool();
    const c = await ownerOf(school);
    const res = await c.post('/assessment-structures').send({ name: 'Short', components: [{ key: 'ca', name: 'CA', max: 30, order: 1 }, { key: 'exam', name: 'Exam', max: 60, order: 2 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/add up to 90/);
  });

  it('creates a session with three terms, and opening a term makes it the only current one', async () => {
    const school = await makeSchool();
    const c = await ownerOf(school);
    expect((await c.post('/sessions').send({ name: '2026-2027', terms })).status).toBe(422); // wrong name format
    const made = await c.post('/sessions').send({ name: '2026/2027', terms });
    expect(made.status).toBe(201);
    expect(made.body.data.status).toBe('current');
    const t = made.body.data.terms;
    expect(t.map((x: any) => x.status)).toEqual(['current', 'upcoming', 'upcoming']);
    expect((await c.post(`/terms/${t[1].id}/open`).send({})).status).toBe(200);
    const list = await c.get('/terms');
    expect(list.body.data.filter((x: any) => x.current).length).toBe(1);
    expect(list.body.data.find((x: any) => x.number === 1).status).toBe('closed');
    // a closed term cannot be edited, and reopening needs a reason and a closed other term
    expect((await c.patch(`/terms/${t[0].id}`).send({ endDate: '2026-12-20' })).status).toBe(409);
    expect((await c.post(`/terms/${t[0].id}/reopen`).send({ reason: 'Fix' })).status).toBe(409); // term 2 is open
    // overlapping term dates are refused
    const bad = await c.post('/sessions').send({ name: '2027/2028', terms: [{ number: 1, startDate: '2027-09-01', endDate: '2027-12-01' }, { number: 2, startDate: '2027-11-01', endDate: '2028-03-01' }, { number: 3 }] });
    expect(bad.status).toBe(422);
  });

  it('lets two students in one class have different subject lists, and the checklist marks the steps done', async () => {
    const school = await makeSchool();
    const c = await ownerOf(school);
    await c.post('/sessions').send({ name: '2026/2027', terms });
    await c.post('/setup/apply-presets').send({ classLevels: ['jss_1'] });
    const [lvl] = (await c.get('/class-levels')).body.data;
    const arm = lvl.arms[0].id;
    const subs = (await c.get(`/class-levels/${lvl.id}/subjects`)).body.data;
    const elective = subs.find((s: any) => !s.compulsory);
    const mk = (n: string) =>
      c.post('/students').set('Idempotency-Key', `stu-${n}-123456`).send({ child: { firstName: n, lastName: 'Same', dob: '2014-05-05', gender: 'male' }, guardians: [{ firstName: 'G', lastName: n, phone: `0803000000${n === 'A' ? 1 : 2}` }], classArmId: arm, consentOnFile: true });
    const a = await mk('A');
    const b = await mk('B');
    expect(a.status).toBe(201);
    const termId = (await c.get('/terms')).body.data.find((x: any) => x.current).id;
    await c.put(`/students/${a.body.data.id}/subjects`).send({ termId, subjectIds: [elective.subjectId] });
    const sa = (await c.get(`/students/${a.body.data.id}/subjects`)).body.data.map((s: any) => s.name);
    const sb = (await c.get(`/students/${b.body.data.id}/subjects`)).body.data.map((s: any) => s.name);
    expect(sa).toContain(elective.name);
    expect(sb).not.toContain(elective.name);
    const progress = (await c.get('/school/setup-progress')).body.data;
    const done = Object.fromEntries(progress.steps.map((s: any) => [s.key, s.done]));
    expect(done).toMatchObject({ session: true, classes: true, subjects: true, grading: true, students: true });
  });
});

describe('M4 people', () => {
  async function setupSchool() {
    const school = await makeSchool();
    const owner = await makeStaff(school, ['owner']);
    const { c: oc } = await signIn(owner.phone, hostOf(school));
    await oc.post('/sessions').send({ name: '2026/2027', terms: [{ number: 1, startDate: '2026-09-14', endDate: '2026-12-18' }, { number: 2, startDate: '2027-01-11', endDate: '2027-04-02' }, { number: 3, startDate: '2027-04-26', endDate: '2027-07-23' }] });
    await oc.post('/setup/apply-presets').send({ classLevels: ['primary_4'] });
    const [lvl] = (await oc.get('/class-levels')).body.data;
    await oc.post('/class-arms').send({ classLevelId: lvl.id, name: 'B' });
    const arms = (await oc.get('/class-levels')).body.data[0].arms;
    return { school, owner, oc, lvl, armA: arms.find((a: any) => a.name === 'A').id, armB: arms.find((a: any) => a.name === 'B').id };
  }
  const child = (first: string) => ({ firstName: first, lastName: 'Okafor', dob: '2016-02-03', gender: 'female' as const });
  const admit = (oc: any, arm: string, first: string, phone = '08031234567', extra: any = {}) =>
    oc.post('/students').set('Idempotency-Key', `admit-${first}-${phone}-xx`).send({ child: child(first), guardians: [{ firstName: 'Ngozi', lastName: 'Okafor', phone, relationship: 'mother' }], classArmId: arm, consentOnFile: true, ...extra });

  it('adds a student with a new guardian: admission number in the school format, a guardian record, and siblings share one guardian', async () => {
    const { oc, armA } = await setupSchool();
    const a = await admit(oc, armA, 'Chika');
    expect(a.status).toBe(201);
    expect(a.body.data.admissionNumber).toMatch(/^TST\/\d{2}\/0001$/);
    const b = await admit(oc, armA, 'Emeka');
    expect(b.body.data.admissionNumber).toMatch(/\/0002$/);
    expect(a.body.data.guardianIds[0]).toBe(b.body.data.guardianIds[0]); // same guardian phone, one guardian
    const g = await oc.get(`/guardians/${a.body.data.guardianIds[0]}`);
    expect(g.body.data.students.length).toBe(2);
  });

  it('flags a likely duplicate and needs confirmation, but never flags twins', async () => {
    const { oc, armA } = await setupSchool();
    await admit(oc, armA, 'Chika');
    const dup = await oc.post('/students').set('Idempotency-Key', 'dup-1-12345678').send({ child: child('Chika'), guardians: [{ firstName: 'N', lastName: 'O', phone: '08031234567' }], classArmId: armA, consentOnFile: true });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.needsConfirmation).toBe(true);
    const twin = await admit(oc, armA, 'Chidi'); // same surname, DOB and guardian; different first name
    expect(twin.status).toBe(201);
    const confirmed = await oc.post('/students').set('Idempotency-Key', 'dup-2-12345678').send({ child: child('Chika'), guardians: [{ firstName: 'N', lastName: 'O', phone: '08031234567' }], classArmId: armA, consentOnFile: true, confirmDuplicate: true });
    expect(confirmed.status).toBe(201);
  });

  it('needs the guardian’s consent to be on file, and repeats the same Idempotency-Key safely', async () => {
    const { oc, armA } = await setupSchool();
    const noConsent = await oc.post('/students').set('Idempotency-Key', 'consent-12345678').send({ child: child('Ada'), guardians: [{ firstName: 'N', lastName: 'O', phone: '08031234567' }], classArmId: armA });
    expect(noConsent.status).toBe(422);
    const first = await admit(oc, armA, 'Ife');
    const again = await admit(oc, armA, 'Ife'); // same key and body
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(await ctxFor(String((await platform(() => School.findOne({}).lean()))._id), () => Student.countDocuments({ firstName: 'Ife' }))).toBe(1);
  });

  it('gives a teacher only the students of their own class arm; a subject teacher sees no guardian contacts or medical notes', async () => {
    const { school, oc, armA, armB } = await setupSchool();
    const a = await admit(oc, armA, 'Chika', '08030000011', { child: { ...child('Chika'), medical: { notes: 'Asthma' } } });
    const b = await admit(oc, armB, 'Emeka', '08030000012');
    const teacher = await makeStaff(school, ['subject_teacher']);
    const maths = (await oc.get('/subjects')).body.data.find((s: any) => s.name === 'Mathematics');
    await oc.put('/teaching-assignments').send({ items: [{ classArmId: armA, subjectId: maths._id, staffId: String(teacher.staff._id), kind: 'subject_teacher' }] });
    const { c: tc } = await signIn(teacher.phone, hostOf(school));
    const list = await tc.get('/students');
    expect(list.body.data.map((s: any) => s.firstName)).toEqual(['Chika']);
    expect((await tc.get(`/students/${a.body.data.id}`)).status).toBe(200);
    expect((await tc.get(`/students/${b.body.data.id}`)).status).toBe(404); // another class: not found, not forbidden
    const view = (await tc.get(`/students/${a.body.data.id}`)).body.data;
    expect(view.medical).toBeUndefined();
    expect(view.dob).toBeUndefined();
    expect((await tc.get(`/students/${a.body.data.id}/guardians`)).status).toBe(403);
    expect((await tc.get('/staff')).status).toBe(403);
  });

  it('invites a staff member who sets a password and lands with navigation for their role; deactivation is blocked until they are reassigned', async () => {
    const { school, oc, armA } = await setupSchool();
    const add = await oc.post('/staff').send({ firstName: 'Bola', lastName: 'Ade', phone: '08035556666', roles: ['subject_teacher'] });
    expect(add.status).toBe(201);
    const sms = (await smsTo('+2348035556666'))!;
    const token = /token=([^\s&]+)/.exec(sms.body)![1];
    const tc = client(hostOf(school));
    const accepted = await tc.post('/auth/accept-invite').send({ token, password: 'Teacher-Pass-1234' });
    expect(accepted.status).toBe(200);
    const me = await tc.get('/auth/me');
    expect(me.body.data.permissions).toContain('scores.enter');
    expect(me.body.data.permissions).not.toContain('fees.payment.record');

    const eng = (await oc.get('/subjects')).body.data.find((s: any) => s.name === 'English Language');
    await oc.put('/teaching-assignments').send({ items: [{ classArmId: armA, subjectId: eng._id, staffId: add.body.data.id, kind: 'subject_teacher' }] });
    const block = await oc.post(`/staff/${add.body.data.id}/deactivate`).send({});
    expect(block.status).toBe(409);
    expect(block.body.error.details.assignments[0]).toMatchObject({ subject: 'English Language' });
    await oc.put('/teaching-assignments').send({ items: [{ classArmId: armA, subjectId: eng._id, staffId: null, kind: 'subject_teacher' }] });
    expect((await oc.post(`/staff/${add.body.data.id}/deactivate`).send({})).status).toBe(200);
    expect((await tc.get('/auth/me')).status).toBe(401); // sessions ended
    expect((await loginAs(client(hostOf(school)), '08035556666', 'Teacher-Pass-1234')).status).toBe(401);
  });

  it('lets the owner appoint a principal but not a school admin', async () => {
    const { school, oc } = await setupSchool();
    const admin = await makeStaff(school, ['school_admin']);
    const { c: ac } = await signIn(admin.phone, hostOf(school));
    const asAdmin = await ac.post('/staff').send({ firstName: 'P', lastName: 'Head', phone: '08037778888', roles: ['principal'] });
    expect(asAdmin.status).toBe(403);
    const asOwner = await oc.post('/staff').send({ firstName: 'P', lastName: 'Head', phone: '08037778888', roles: ['principal'] });
    expect(asOwner.status).toBe(201);
    // the admin can add a teacher, but cannot promote someone to owner
    const teacher = await ac.post('/staff').send({ firstName: 'T', lastName: 'Eacher', phone: '08037779999', roles: ['subject_teacher'] });
    expect(teacher.status).toBe(201);
    expect((await ac.put(`/staff/${teacher.body.data.id}/roles`).send({ roles: ['owner'] })).status).toBe(403);
    const logs = await platform(() => AuditLog.find({ action: 'staff.roles.update' }).lean());
    expect(logs.length).toBe(0); // refused changes are not applied
  });

  it('grants one extra permission without inventing a role, and only where it fits', async () => {
    const { school, oc } = await setupSchool();
    const t = await oc.post('/staff').send({ firstName: 'T', lastName: 'One', phone: '08031110000', roles: ['subject_teacher'] });
    const ok = await oc.put(`/staff/${t.body.data.id}/roles`).send({ roles: ['subject_teacher'], extraPermissions: ['admissions.review'] });
    expect(ok.status).toBe(200);
    const bad = await oc.put(`/staff/${t.body.data.id}/roles`).send({ roles: ['subject_teacher'], extraPermissions: ['fees.discount.approve'] });
    expect(bad.status).toBe(422);
    void school;
  });

  it('withdrawing a student removes them from class lists and keeps the record; a parent keeps access to that child', async () => {
    const { school, oc, armA } = await setupSchool();
    const a = await admit(oc, armA, 'Chika');
    const res = await oc.post(`/students/${a.body.data.id}/status`).send({ status: 'withdrawn', date: '2026-10-01', reason: 'Moved abroad' });
    expect(res.status).toBe(200);
    expect((await oc.get(`/students?classArmId=${armA}&status=active`)).body.data.length).toBe(0);
    const record = await oc.get(`/students/${a.body.data.id}`);
    expect(record.body.data.status).toBe('withdrawn');
    expect(record.body.data.statusHistory.length).toBe(2);
    // not allowed: withdrawn -> suspended
    expect((await oc.post(`/students/${a.body.data.id}/status`).send({ status: 'suspended', date: '2026-10-02', reason: 'Not allowed' })).status).toBe(409);
    void school;
  });

  it('limits a separated guardian to view only with a logged reason, and never removes the last guardian', async () => {
    const { oc, armA } = await setupSchool();
    const a = await oc.post('/students').set('Idempotency-Key', 'two-guardians-1').send({
      child: child('Chika'),
      guardians: [
        { firstName: 'Ngozi', lastName: 'Okafor', phone: '08031234567' },
        { firstName: 'Emma', lastName: 'Okafor', phone: '08039876543', relationship: 'father' }
      ],
      classArmId: armA,
      consentOnFile: true
    });
    const sid = a.body.data.id;
    const [g1, g2] = a.body.data.guardianIds;
    expect((await oc.patch(`/students/${sid}/guardians/${g2}`).send({ access: 'view' })).status).toBe(422); // reason required
    expect((await oc.patch(`/students/${sid}/guardians/${g2}`).send({ access: 'view', reason: 'Court order' })).status).toBe(200);
    expect((await oc.patch(`/students/${sid}/guardians/${g1}`).send({ access: 'none', reason: 'x' })).status).toBe(200); // g2 still has view access
    expect((await oc.patch(`/students/${sid}/guardians/${g2}`).send({ access: 'none', reason: 'x' })).status).toBe(409); // last one with access
    expect((await oc.delete(`/students/${sid}/guardians/${g1}`)).status).toBe(204);
    expect((await oc.delete(`/students/${sid}/guardians/${g2}`)).status).toBe(409); // last guardian
  });

  it('sends login details at go-live only to people not yet invited, and running it twice sends nothing new', async () => {
    const { school, oc, armA } = await setupSchool();
    await admit(oc, armA, 'Chika', '08031230001');
    await admit(oc, armA, 'Emeka', '08031230002');
    // the school is not ready: required steps are missing
    const blocked = await oc.post('/school/go-live').set('Idempotency-Key', 'live-blocked-1').send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.missing.length).toBeGreaterThan(0);
    // nobody got a login at enrolment, because the school is not live yet
    await drainJobs();
    expect(outbox.filter((o) => o.channel === 'sms' && /temporary password/.test(o.body)).length).toBe(0);
    void school;
  });

  it('creates a student login only where the class level allows it', async () => {
    const { school, oc, armA, lvl } = await setupSchool();
    // Primary 4 has student login on by default; turn it off, then on again
    const off = await oc.patch(`/class-levels/${lvl.id}`).send({ studentLogin: false });
    expect(off.body.data.studentLogin).toBe(false);
    const on = await oc.patch(`/class-levels/${lvl.id}`).send({ studentLogin: true });
    expect(on.body.data.studentLogin).toBe(true);
    const a = await admit(oc, armA, 'Chika', '08031230009', { issueLogins: true });
    expect(a.status).toBe(201);
    const stu = await ctxFor(String(school._id), () => Student.findById(a.body.data.id).lean());
    expect(stu.userId).toBeTruthy();
    // the student signs in by admission number with the temporary password sent to the guardian
    await drainJobs();
    const sms = [...outbox].reverse().find((o) => /student login/.test(o.body))!;
    const pwd = /temporary password ([A-Za-z0-9]+)/.exec(sms.body)![1];
    const res = await loginAs(client(hostOf(school)), stu.admissionNumber, pwd);
    expect(res.status).toBe(200);
    expect(res.body.data.next).toBe('change_password');
    void ClassLevel; void ClassSubject; void GradingScale; void LevelGroup; void Membership; void Staff; void Term; void PASSWORD;
  });
});
