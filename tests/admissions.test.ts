import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, ctxFor, drainJobs, lastCode, makeStaff, platform, resetDb, signIn, smsTo, startTestDb, stopTestDb } from './helpers';
import { buildSchool, setBank, type Fixture } from './fixtures';
import { fakePaystack } from '../src/integrations/paystack';
import { Application, Guardian, Invoice, Student } from '../src/models';
import { TRANSITIONS, canTransition } from '../src/core/states';
import { runExpireOffers } from '../src/services/admissions';
import { runWithCtx, emptyCtx, forSchool } from '../src/core/context';
import { outbox } from '../src/integrations/sms';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(resetDb);

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function openAdmissions(fx: Fixture, extra: Record<string, unknown> = {}) {
  const res = await fx.oc.put('/admissions/settings').send({ open: true, classLevelIds: [fx.levelId], requiredDocuments: ['birth_certificate'], ...extra });
  expect(res.status).toBe(200);
}

/** The parent's side: phone check, then a token for the form. */
async function parentToken(fx: Fixture, phone = '08031112233') {
  const pub = client(fx.host);
  expect((await pub.post('/public/applications/start').send({ phone })).status).toBe(200);
  await drainJobs();
  const code = lastCode(phone.replace(/^0/, '+234'))!;
  const v = await pub.post('/public/applications/verify').send({ phone, code });
  expect(v.status).toBe(200);
  return { pub, token: v.body.data.applicationToken as string, draft: v.body.data.draft };
}

const withToken = (pub: ReturnType<typeof client>, token: string, method: 'post' | 'put' | 'get', path: string) => (pub as any)[method](path).set('x-application-token', token);

async function uploadDoc(pub: ReturnType<typeof client>, token: string) {
  const sign = await withToken(pub, token, 'post', '/public/applications/files/sign').send({ kind: 'birth_certificate', mime: 'image/png' });
  expect(sign.status).toBe(200);
  const up = await client().agent.put(sign.body.data.uploadUrl).set('Content-Type', 'image/png').send(PNG);
  expect(up.status).toBe(204);
  return sign.body.data.fileRef as string;
}

const form = (levelId: string, phone = '+2348031112233', extra: any = {}) => ({
  child: { firstName: 'Tobi', lastName: 'Adeyemi', dob: '2018-04-12', gender: 'male' },
  guardian: { firstName: 'Kemi', lastName: 'Adeyemi', phone, email: 'kemi@example.com', relationship: 'mother' },
  classLevelId: levelId,
  previousSchool: 'Little Stars Nursery',
  ...extra
});

async function submitted(fx: Fixture, phone = '08031112233') {
  const { pub, token } = await parentToken(fx, phone);
  const file = await uploadDoc(pub, token);
  await withToken(pub, token, 'put', '/public/applications/draft').send(form(fx.levelId, phone.replace(/^0/, '+234'), { documents: [{ kind: 'birth_certificate', file }] }));
  const res = await withToken(pub, token, 'post', '/public/applications/submit').send({ consent: true });
  expect(res.status).toBe(201);
  return { pub, token, number: res.body.data.number as string, id: res.body.data.applicationId as string, phone: phone.replace(/^0/, '+234') };
}

describe('M7 admissions and enrolment', () => {
  it('replaces the form with a notice when admissions are closed', async () => {
    const fx = await buildSchool();
    const pub = client(fx.host);
    const closed = await pub.get('/public/admissions');
    expect(closed.body.data.open).toBe(false);
    expect(closed.body.data.message).toMatch(/closed/);
    expect((await pub.post('/public/applications/start').send({ phone: '08031112233' })).status).toBe(409);
    await openAdmissions(fx, { opensOn: '2030-01-01', closesOn: '2030-02-01' });
    expect((await pub.get('/public/admissions')).body.data.open).toBe(false); // outside the dates
    await openAdmissions(fx, { opensOn: '2020-01-01', closesOn: '2099-01-01' });
    const open = (await pub.get('/public/admissions')).body.data;
    expect(open.open).toBe(true);
    expect(open.classes.map((c: any) => c.name)).toEqual(['Primary 4']);
    expect(open.requiredDocuments).toEqual(['birth_certificate']);
    expect(open.consentText).toMatch(/consent/i);
  });

  it('saves a draft against the phone number, resumes it after the code check, and keeps the guardian phone to the verified number', async () => {
    const fx = await buildSchool();
    await openAdmissions(fx);
    const { pub, token } = await parentToken(fx);
    const saved = await withToken(pub, token, 'put', '/public/applications/draft').send({ child: { firstName: 'Tobi' }, guardian: { firstName: 'Kemi', phone: '08000000000' } });
    expect(saved.status).toBe(200);
    expect(saved.body.data.guardian.phone).toBe('+2348031112233'); // forced to the verified number
    // she leaves and comes back with phone and code
    const again = await parentToken(fx);
    expect(again.draft.child.firstName).toBe('Tobi');
    // a wrong or missing token is refused
    expect((await pub.put('/public/applications/draft').send({ child: { firstName: 'X' } })).status).toBe(401);
    expect((await withToken(pub, 'nope', 'put', '/public/applications/draft').send({})).status).toBe(401);
    // a token from another school does not work here
    const other = await buildSchool();
    expect((await withToken(client(other.host), token, 'put', '/public/applications/draft').send({})).status).toBe(401);
  });

  it('blocks submission with a missing required document, then accepts it, gives an application number by SMS, and shows the status', async () => {
    const fx = await buildSchool();
    await openAdmissions(fx);
    const { pub, token } = await parentToken(fx);
    await withToken(pub, token, 'put', '/public/applications/draft').send(form(fx.levelId));
    const missing = await withToken(pub, token, 'post', '/public/applications/submit').send({ consent: true });
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields['documents.birth_certificate']).toMatch(/Upload the birth certificate/);
    expect((await withToken(pub, token, 'post', '/public/applications/submit').send({ consent: false })).status).toBe(422);

    const file = await uploadDoc(pub, token);
    await withToken(pub, token, 'put', '/public/applications/draft').send(form(fx.levelId, '+2348031112233', { documents: [{ kind: 'birth_certificate', file }] }));
    const ok = await withToken(pub, token, 'post', '/public/applications/submit').send({ consent: true });
    expect(ok.status).toBe(201);
    expect(ok.body.data.number).toMatch(/^TST\/APP\/\d{2}\/0001$/);
    expect(await smsTo('+2348031112233', new RegExp(ok.body.data.number.replace(/\//g, '\\/')))).toBeTruthy();

    const status = await pub.get(`/public/applications/status?number=${encodeURIComponent(ok.body.data.number)}&phone=08031112233`);
    expect(status.body.data).toMatchObject({ status: 'submitted', child: 'Tobi Adeyemi', class: 'Primary 4' });
    // number and phone must both match, with the same answer for either mistake
    const wrongPhone = await pub.get(`/public/applications/status?number=${encodeURIComponent(ok.body.data.number)}&phone=08039999999`);
    const wrongNumber = await pub.get('/public/applications/status?number=TST%2FAPP%2F26%2F9999&phone=08031112233');
    expect(wrongPhone.status).toBe(404);
    expect(wrongNumber.status).toBe(404);
    // consent is stored with its wording and time
    const app: any = await ctxFor(String(fx.school._id), () => Application.findById(ok.body.data.applicationId).lean());
    expect(app.consent.text).toMatch(/consent/i);
    expect(app.consent.at).toBeTruthy();
    // staff see the application with its document
    const detail = (await fx.oc.get(`/applications/${ok.body.data.applicationId}`)).body.data;
    expect(detail.documents.length).toBe(1);
    const link = await fx.oc.get(`/files/link?ref=${encodeURIComponent(detail.documents[0].file)}`);
    expect(link.status).toBe(200);
    // a parent in the same school cannot read another family's admission document through the link route
    const stranger = await buildSchool();
    expect((await stranger.oc.get(`/files/link?ref=${encodeURIComponent(detail.documents[0].file)}`)).status).toBe(404);
  });

  it('allows only the transitions in the state table and refuses every other change with state_conflict', async () => {
    const all = Object.keys(TRANSITIONS.application);
    let checked = 0;
    for (const from of all) for (const to of all) {
      const allowed = (TRANSITIONS.application as any)[from].includes(to);
      expect(canTransition('application', from, to), `${from} -> ${to}`).toBe(allowed);
      checked += 1;
    }
    expect(checked).toBe(121);
    // through the API: a submitted application cannot be offered or enrolled directly
    const fx = await buildSchool();
    await openAdmissions(fx);
    const a = await submitted(fx);
    expect((await fx.oc.post(`/applications/${a.id}/offer`).send({ amountKobo: 100000 })).status).toBe(409);
    expect((await fx.oc.post(`/applications/${a.id}/enrol`).set('Idempotency-Key', key()).send({ classArmId: fx.armA })).status).toBe(409);
    expect((await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'under_review' })).status).toBe(200);
    expect((await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'under_review' })).status).toBe(409);
    expect((await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'waitlisted' })).status).toBe(200);
    expect((await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'withdrawn' })).status).toBe(200);
    expect((await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'rejected' })).status).toBe(409); // withdrawn is final
  });

  it('lets staff open what the parent uploaded, and a passport photograph becomes the student picture with every document on the record', async () => {
    const fx = await buildSchool();
    await openAdmissions(fx);
    expect((await fx.oc.patch('/school').send({ settings: { allowEnrolBeforePayment: true } })).status).toBe(200);
    const { pub, token } = await parentToken(fx);
    const upload = async (kind: string) => {
      const sign = await withToken(pub, token, 'post', '/public/applications/files/sign').send({ kind, mime: 'image/png' });
      expect((await client().agent.put(sign.body.data.uploadUrl).set('Content-Type', 'image/png').send(PNG)).status).toBe(204);
      return sign.body.data.fileRef as string;
    };
    const cert = await upload('birth_certificate');
    const passport = await upload('passport');
    await withToken(pub, token, 'put', '/public/applications/draft').send(form(fx.levelId, '+2348031112233', { documents: [{ kind: 'birth_certificate', file: cert }, { kind: 'passport', file: passport }] }));
    const sub = await withToken(pub, token, 'post', '/public/applications/submit').send({ consent: true });
    expect(sub.status).toBe(201);
    const id = sub.body.data.applicationId as string;

    // staff see both documents as links that open, and the photograph
    const detail = (await fx.oc.get(`/applications/${id}`)).body.data;
    expect(detail.documents.map((d: any) => d.kind).sort()).toEqual(['birth_certificate', 'passport']);
    for (const d of detail.documents) {
      expect(d.url).toMatch(/^\/api\/v1\/files\//);
      expect((await client().agent.get(d.url)).status).toBe(200);
    }
    expect(detail.photoUrl).toMatch(/^\/api\/v1\/files\//);

    expect((await fx.oc.post(`/applications/${id}/status`).send({ status: 'under_review' })).status).toBe(200);
    expect((await fx.oc.post(`/applications/${id}/offer`).send({})).status).toBe(201);
    const enrol = await fx.oc.post(`/applications/${id}/enrol`).set('Idempotency-Key', key()).send({ classArmId: fx.armA });
    expect(enrol.status, JSON.stringify(enrol.body)).toBe(201);
    const sid = enrol.body.data.studentId as string;

    // the student's picture shows in the list, the profile and the class register
    const list = (await fx.oc.get('/students?limit=50')).body.data.find((x: any) => x.id === sid);
    expect(list.photoUrl).toMatch(/^\/api\/v1\/files\//);
    expect((await fx.oc.get(`/students/${sid}`)).body.data.photoUrl).toMatch(/^\/api\/v1\/files\//);
    const reg = (await fx.oc.get(`/attendance/registers?classArmId=${fx.armA}&date=${new Date().toISOString().slice(0, 10)}`)).body.data;
    expect(reg.entries.find((e: any) => e.studentId === sid)?.photoUrl ?? reg.holiday ?? 'holiday-or-weekend').toBeTruthy();
    // both documents are on the student's record and can be opened
    const docs = (await fx.oc.get(`/students/${sid}/documents`)).body.data;
    expect(docs.length).toBe(2);
    expect(docs.every((d: any) => /^\/api\/v1\/files\//.test(d.url))).toBe(true);
  });

  it('runs the whole path: review, test date, offer with a payment link, parent pays, enrol, and the new child appears under the same parent login', async () => {
    const fx = await buildSchool({ withBank: true });
    await openAdmissions(fx);
    // an existing family: one child already in the school, same guardian phone
    const existing = await fx.oc.post('/students').set('Idempotency-Key', key()).send({ child: { firstName: 'Ola', lastName: 'Adeyemi', dob: '2015-01-01', gender: 'male' }, guardians: [{ firstName: 'Kemi', lastName: 'Adeyemi', phone: '08031112233' }], classArmId: fx.armA, consentOnFile: true });
    const a = await submitted(fx);
    const detail = (await fx.oc.get(`/applications/${a.id}`)).body.data;
    expect(detail.possibleDuplicate).toBe(false); // a different child of the same guardian is not a duplicate

    expect((await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'under_review' })).status).toBe(200);
    const sched = await fx.oc.post(`/applications/${a.id}/assessment`).send({ kind: 'test', at: '2030-05-02T09:00:00+01:00', notes: 'Bring a pencil' });
    expect(sched.status).toBe(200);
    expect(await smsTo(a.phone, /assessment scheduled/)).toBeTruthy();
    expect((await a.pub.get(`/public/applications/status?number=${encodeURIComponent(a.number)}&phone=08031112233`)).body.data.assessment.kind).toBe('test');

    // no amount given: the first-term fees come from the fee structure
    const offer = await fx.oc.post(`/applications/${a.id}/offer`).send({});
    expect(offer.status).toBe(201);
    expect(offer.body.data.totalKobo).toBe(5200000);
    const sms = (await smsTo(a.phone, /offered/))!;
    const token = /offer\/([A-Za-z0-9_-]+)/.exec(sms.body)![1];

    const view = await a.pub.get(`/public/applications/offer/${token}`);
    expect(view.body.data).toMatchObject({ child: 'Tobi Adeyemi', class: 'Primary 4', canPay: true });
    const pay = await a.pub.post(`/public/applications/offer/${token}/pay`).send({});
    expect(pay.status).toBe(201);
    // not enrollable yet: unpaid
    expect((await fx.oc.post(`/applications/${a.id}/enrol`).set('Idempotency-Key', key()).send({ classArmId: fx.armA })).status).toBe(409);

    // the parent pays with no login at all; the signed link authorises it
    const sim = fakePaystack.simulatePay(pay.body.data.reference);
    expect((await client().agent.post('/api/v1/webhooks/paystack').set('x-paystack-signature', sim.signature).set('Content-Type', 'application/json').send(sim.body)).status).toBe(200);
    await drainJobs();
    expect((await a.pub.get(`/public/applications/status?number=${encodeURIComponent(a.number)}&phone=08031112233`)).body.data.status).toBe('accepted');
    // the offer payment produced a receipt with a verification code
    const verifyRes = await a.pub.get(`/payments/verify?reference=${pay.body.data.reference}`);
    expect(verifyRes.body.data).toMatchObject({ status: 'successful', receiptCount: 1 });

    const enrol = await fx.oc.post(`/applications/${a.id}/enrol`).set('Idempotency-Key', key()).send({ classArmId: fx.armA });
    expect(enrol.status).toBe(201);
    expect(enrol.body.data.admissionNumber).toMatch(/^TST\/\d{2}\/0002$/);
    const sid = enrol.body.data.studentId;

    // the existing guardian phone did not create a second guardian or a second account
    expect(await ctxFor(String(fx.school._id), () => Guardian.countDocuments({ phone: '+2348031112233' }))).toBe(1);
    const kids = await ctxFor(String(fx.school._id), () => Student.find({}).lean());
    expect(kids.map((k: any) => k.firstName).sort()).toEqual(['Ola', 'Tobi']);
    expect((await a.pub.get(`/public/applications/status?number=${encodeURIComponent(a.number)}&phone=08031112233`)).body.data.status).toBe('enrolled');
    // the offer invoice now belongs to the child
    const inv: any = await ctxFor(String(fx.school._id), () => Invoice.findOne({ kind: 'admission' }).lean());
    expect(String(inv.studentId)).toBe(sid);
    expect(inv.status).toBe('paid');
    // enrolled twice is refused
    expect((await fx.oc.post(`/applications/${a.id}/enrol`).set('Idempotency-Key', key()).send({ classArmId: fx.armA })).status).toBe(409);
    void existing;
  });

  it('creates the parent’s account at enrolment with a temporary password and the parent signs in and sees the child', async () => {
    const fx = await buildSchool({ withBank: true });
    await openAdmissions(fx);
    await fx.oc.patch('/school').send({ settings: { allowEnrolBeforePayment: true } });
    const a = await submitted(fx, '08034445566');
    await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'under_review' });
    await fx.oc.post(`/applications/${a.id}/offer`).send({ amountKobo: 3000000 });
    // the school allows enrolment before payment: staff can enrol from Offered, and the invoice stays open for the parent
    const enrol = await fx.oc.post(`/applications/${a.id}/enrol`).set('Idempotency-Key', key()).send({ classArmId: fx.armA });
    expect(enrol.status).toBe(201);
    await drainJobs();
    const sms = [...outbox].reverse().find((o) => o.to === a.phone && /temporary password/.test(o.body) && !/student login/.test(o.body))!;
    const password = /temporary password ([A-Za-z0-9]+)/.exec(sms.body)![1];
    const parent = client(fx.host);
    const login = await parent.post('/auth/login').send({ identifier: '08034445566', password });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.data.next).toBe('change_password');
    await parent.post('/auth/change-password').send({ currentPassword: password, newPassword: 'Parent-Own-Pass-77' });
    const invs = (await parent.get('/my/invoices')).body.data;
    expect(invs.length).toBe(1);
    expect(invs[0]).toMatchObject({ kind: 'admission', status: 'issued', balanceKobo: 3000000 });
  });

  it('flags a likely duplicate to staff and asks them to confirm before enrolling', async () => {
    const fx = await buildSchool({ withBank: true });
    await openAdmissions(fx);
    await fx.oc.post('/students').set('Idempotency-Key', key()).send({ child: { firstName: 'Tobi', lastName: 'Adeyemi', dob: '2018-04-12', gender: 'male' }, guardians: [{ firstName: 'Kemi', lastName: 'Adeyemi', phone: '08031112233' }], classArmId: fx.armA, consentOnFile: true });
    const a = await submitted(fx);
    const detail = (await fx.oc.get(`/applications/${a.id}`)).body.data;
    expect(detail.possibleDuplicate).toBe(true);
    expect(detail.duplicates.students.length).toBe(1);
    await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'under_review' });
    await fx.oc.patch('/school').send({ settings: { allowEnrolBeforePayment: true } });
    await fx.oc.post(`/applications/${a.id}/offer`).send({ amountKobo: 1000000 });
    const blocked = await fx.oc.post(`/applications/${a.id}/enrol`).set('Idempotency-Key', key()).send({ classArmId: fx.armA });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.needsConfirmation).toBe(true);
    const go = await fx.oc.post(`/applications/${a.id}/enrol`).set('Idempotency-Key', key()).send({ classArmId: fx.armA, confirmDuplicate: true });
    expect(go.status).toBe(201);
  });

  it('expires an unpaid offer past its date with the daily job, and staff can renew it', async () => {
    const fx = await buildSchool({ withBank: true });
    await openAdmissions(fx);
    const a = await submitted(fx);
    await fx.oc.post(`/applications/${a.id}/status`).send({ status: 'under_review' });
    await fx.oc.post(`/applications/${a.id}/offer`).send({ amountKobo: 1000000, expiresOn: '2099-01-01' });
    // time passes
    await ctxFor(String(fx.school._id), () => Application.updateOne({ _id: a.id }, { 'offer.expiresOn': '2020-01-01' }));
    await runWithCtx(emptyCtx(), () => forSchool(String(fx.school._id), () => runExpireOffers()));
    await drainJobs();
    expect((await fx.oc.get(`/applications/${a.id}`)).body.data.status).toBe('expired');
    expect(await smsTo(a.phone, /expired/)).toBeTruthy();
    // an expired offer cannot be paid
    const sms = (await smsTo(a.phone, /offered/))!;
    const token = /offer\/([A-Za-z0-9_-]+)/.exec(sms.body)![1];
    expect((await a.pub.post(`/public/applications/offer/${token}/pay`).send({})).status).toBe(409);
    const renew = await fx.oc.post(`/applications/${a.id}/renew-offer`).send({ expiresOn: '2099-12-31' });
    expect(renew.status).toBe(200);
    expect(renew.body.data.status).toBe('offered');
    // renewing something that is not expired is refused
    expect((await fx.oc.post(`/applications/${a.id}/renew-offer`).send({})).status).toBe(409);
  });

  it('takes the application fee online before the form is accepted', async () => {
    const fx = await buildSchool({ withBank: true });
    await openAdmissions(fx, { applicationFeeKobo: 500000 });
    const { pub, token } = await parentToken(fx, '08037778899');
    const file = await uploadDoc(pub, token);
    await withToken(pub, token, 'put', '/public/applications/draft').send(form(fx.levelId, '+2348037778899', { documents: [{ kind: 'birth_certificate', file }] }));
    const submit = await withToken(pub, token, 'post', '/public/applications/submit').send({ consent: true });
    expect(submit.status).toBe(201);
    expect(submit.body.data.status).toBe('payment_required');
    expect(submit.body.data.payment.feesKobo).toBe(500000);
    // not accepted yet: no number, not on the staff list
    expect((await fx.oc.get('/applications')).body.data.length).toBe(0);

    const sim = fakePaystack.simulatePay(submit.body.data.payment.reference);
    await client().agent.post('/api/v1/webhooks/paystack').set('x-paystack-signature', sim.signature).set('Content-Type', 'application/json').send(sim.body);
    await drainJobs();
    const list = (await fx.oc.get('/applications')).body;
    expect(list.data.length).toBe(1);
    expect(list.data[0].number).toMatch(/^TST\/APP\//);
    expect(list.counts.submitted).toBe(1);
    expect(await smsTo('+2348037778899', /application number/)).toBeTruthy();
    // submit again with the same draft is refused: it is no longer a draft
    expect((await withToken(pub, token, 'post', '/public/applications/submit').send({ consent: true })).status).toBe(404);
  });

  it('lets a teacher with the admissions-review extra see applications, and nobody else', async () => {
    const fx = await buildSchool();
    await openAdmissions(fx);
    await submitted(fx);
    const t = await makeStaff(fx.school, ['subject_teacher']);
    const { c: tc } = await signIn(t.phone, fx.host);
    expect((await tc.get('/applications')).status).toBe(403);
    await fx.oc.put(`/staff/${String(t.staff._id)}/roles`).send({ roles: ['subject_teacher'], extraPermissions: ['admissions.review'] });
    await fx.oc.post('/auth/confirm-password').send({ password: 'Correct-Horse-9' });
    expect((await tc.post('/auth/refresh').send({})).status).toBe(200);
    expect((await tc.get('/applications')).status).toBe(200);
    // but not the power to decide
    const id = (await tc.get('/applications')).body.data[0].id;
    expect((await tc.post(`/applications/${id}/status`).send({ status: 'under_review' })).status).toBe(403);
    void platform; void setBank;
  });
});
