import { client, ctxFor, drainJobs, hostOf, makeSchool, makeStaff, makeUser, PASSWORD, platform, signIn, type Client } from './helpers';
import { Guardian, Membership, School } from '../src/models';
import { addDays, todayLagos } from '../src/lib/dates';
import { seedPlatformPresets } from '../src/seed/presets';

// Term dates are relative to today so date-sensitive rules (registers, term windows) hold whenever the suite runs.
const today = todayLagos();
export const TERMS = [
  { number: 1, startDate: addDays(today, -45), endDate: addDays(today, 60), nextTermBegins: addDays(today, 90) },
  { number: 2, startDate: addDays(today, 90), endDate: addDays(today, 170), nextTermBegins: addDays(today, 200) },
  { number: 3, startDate: addDays(today, 200), endDate: addDays(today, 280) }
];

export interface Fixture {
  school: any;
  host: string;
  owner: Awaited<ReturnType<typeof makeStaff>>;
  oc: Client;
  bursar: Awaited<ReturnType<typeof makeStaff>>;
  bc: Client;
  levelId: string;
  armA: string;
  armB: string;
  termId: string;
  sessionId: string;
  items: Record<string, string>;
  students: Array<{ id: string; admissionNumber: string; guardianId: string }>;
}

const naira = (n: number) => n * 100;

/** A school with a session, one class level with two arms, a fee structure and a bursar. Students are added by `addStudent`. */
export async function buildSchool(opts: { levelKey?: string; withBank?: boolean; fees?: Record<string, number>; status?: string } = {}): Promise<Fixture> {
  await seedPlatformPresets();
  const school = await makeSchool({ status: opts.status ?? 'active' });
  const host = hostOf(school);
  const owner = await makeStaff(school, ['owner']);
  const bursar = await makeStaff(school, ['bursar']);
  const { c: oc } = await signIn(owner.phone, host);
  const { c: bc } = await signIn(bursar.phone, host);
  const sess = await oc.post('/sessions').send({ name: '2026/2027', terms: TERMS });
  const sessionId = sess.body.data.id as string;
  const termId = sess.body.data.terms.find((t: any) => t.status === 'current').id as string;
  await oc.post('/setup/apply-presets').send({ classLevels: [opts.levelKey ?? 'primary_4'] });
  const [lvl] = (await oc.get('/class-levels')).body.data;
  await oc.post('/class-arms').send({ classLevelId: lvl.id, name: 'B' });
  const arms = (await oc.get('/class-levels')).body.data[0].arms;
  const feeItems = (await oc.get('/fee-items')).body.data as any[];
  const items = Object.fromEntries(feeItems.map((i) => [i.name, String(i._id)]));
  const amounts = opts.fees ?? { Tuition: 45000, Examination: 5000, 'PTA levy': 2000, Uniform: 8000 };
  await bc.put('/fee-structures').send({ termId, classLevelId: lvl.id, lines: Object.entries(amounts).map(([n, v]) => ({ feeItemId: items[n], amountKobo: naira(v) })) });
  const fx: Fixture = { school, host, owner, oc, bursar, bc, levelId: lvl.id, armA: arms.find((a: any) => a.name === 'A').id, armB: arms.find((a: any) => a.name === 'B').id, termId, sessionId, items, students: [] };
  if (opts.withBank) await setBank(fx);
  return fx;
}

export async function setBank(fx: Fixture) {
  const res = await fx.oc.put('/school/bank').send({ bankCode: '058', accountNumber: '0123456789', accountName: 'TEST ACCOUNT 6789' });
  if (res.status !== 200) throw new Error(`bank setup failed ${res.status} ${JSON.stringify(res.body)}`);
}

let n = 0;
/** Admit a student through the API. */
export async function addStudent(fx: Fixture, over: { first?: string; guardianPhone?: string; arm?: string; last?: string } = {}) {
  n += 1;
  const first = over.first ?? `Kid${n}`;
  const phone = over.guardianPhone ?? `0803100${String(1000 + n)}`;
  const res = await fx.oc.post('/students').set('Idempotency-Key', `fx-student-${n}-${first}-${phone}`).send({
    child: { firstName: first, lastName: over.last ?? 'Fixture', dob: '2016-02-03', gender: 'female' },
    guardians: [{ firstName: 'Parent', lastName: over.last ?? 'Fixture', phone, relationship: 'mother' }],
    classArmId: over.arm ?? fx.armA,
    consentOnFile: true
  });
  if (res.status !== 201) throw new Error(`addStudent failed ${res.status} ${JSON.stringify(res.body)}`);
  const s = { id: res.body.data.id as string, admissionNumber: res.body.data.admissionNumber as string, guardianId: res.body.data.guardianIds[0] as string, phone };
  fx.students.push(s);
  return s;
}

/** Give a guardian a login with a known password, and return a signed-in client on the school's address. */
export async function parentLogin(fx: Fixture, guardianId: string) {
  const g = await ctxFor(String(fx.school._id), () => Guardian.findById(guardianId).lean());
  const user = await makeUser({ firstName: g.firstName, lastName: g.lastName, phone: g.phone });
  await ctxFor(String(fx.school._id), () => Guardian.updateOne({ _id: g._id }, { userId: user._id }));
  await platform(() => Membership.create({ userId: user._id, schoolId: fx.school._id, kind: 'guardian', guardianId: g._id, status: 'active', roles: [] }));
  const { c } = await signIn(g.phone, fx.host, PASSWORD);
  return c;
}

export async function generateInvoices(fx: Fixture) {
  const res = await fx.bc.post('/invoices/generate').set('Idempotency-Key', `gen-${Math.random().toString(36).slice(2)}-xx`).send({ termId: fx.termId });
  if (res.status !== 202) throw new Error(`generate failed ${res.status} ${JSON.stringify(res.body)}`);
  await drainJobs();
  return res;
}

export const reloadSchool = (fx: Fixture) => platform(() => School.findById(fx.school._id).lean());
export { naira };

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

/** Upload a tiny PNG through the signed-upload flow and return its file reference. */
export async function uploadPng(c: Client, purpose = 'site_image', path = '/files/sign') {
  const sign = await c.post(path).send({ purpose, mime: 'image/png' });
  if (sign.status !== 200) throw new Error(`sign failed ${sign.status} ${JSON.stringify(sign.body)}`);
  const up = await client().agent.put(sign.body.data.uploadUrl).set('Content-Type', 'image/png').send(PNG);
  if (up.status !== 204) throw new Error(`upload failed ${up.status}`);
  return sign.body.data.fileRef as string;
}

/** Everything the website needs to publish: branding, and a bank so the checklist is satisfied where it must be. */
export async function readyForWebsite(fx: Fixture) {
  const logo = await uploadPng(fx.oc, 'brand_asset');
  const res = await fx.oc.patch('/school/branding').send({ logo, primary: '#1d4ed8', secondary: '#f59e0b' });
  if (res.status !== 200) throw new Error(`branding failed ${res.status} ${JSON.stringify(res.body)}`);
  return logo;
}
