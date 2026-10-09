import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ctxFor, drainJobs, platform, resetDb, startTestDb, stopTestDb, client } from './helpers';
import { addStudent, buildSchool, generateInvoices, parentLogin, uploadPng, type Fixture } from './fixtures';
import { resultsSchool, type ResultsFixture } from './resultsFixture';
import { routeRegistry } from '../src/core/route';
import { Approval, Application, Enquiry, Guardian, Invoice, Notification, Payment, Post, Receipt, Staff, StudentDocument, Student, Task, Term, AcademicSession, ClassArm, ClassLevel, Subject } from '../src/models';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(resetDb);

/**
 * The tenancy test (Document 3, section 5; Document 5, M1 criterion 9 and M16 criterion 8): a user of school A calls every
 * tenant route with IDs that belong to school B. Nothing from B may come back, and no route may succeed in changing B.
 * It walks the route table, so a route added tomorrow is covered automatically.
 */

async function seedB(): Promise<{ fx: ResultsFixture; ids: string[]; names: string[] }> {
  const fx = await resultsSchool({ students: 2 });
  await generateInvoices(fx);
  await fx.bc.post('/payments/offline').set('Idempotency-Key', 'tenancy-pay-b-0001').send({ studentId: fx.kids[0].id, amountKobo: 100000, channel: 'cash', paidOn: '2026-10-05' });
  const png = await uploadPng(fx.oc, 'student_document');
  await fx.oc.post(`/students/${fx.kids[0].id}/documents`).send({ title: 'Birth certificate', file: png, visibleToGuardian: true });
  await fx.oc.post('/website/posts').send({ title: 'B news', body: 'x', published: true });
  const sid = String(fx.school._id);
  const one = async (M: any, filter: any = {}) => String((await ctxFor(sid, () => M.findOne(filter).lean()))?._id ?? '');
  // a task and an enquiry and an application, so those routes have real records to try to reach
  const t = await fx.teacherA.c.post('/tasks').send({ classArmId: fx.armA, subjectId: fx.subjects['English Language'], type: 'homework', title: 'B homework', maxScore: 10 });
  const ids = [
    ...fx.kids.map((k) => k.id),
    ...fx.kids.map((k) => k.guardianId),
    await one(Invoice),
    await one(Payment),
    await one(Receipt),
    fx.armA,
    fx.armB,
    fx.levelId,
    fx.termId,
    fx.sessionId,
    fx.teacherA.staffId,
    String(t.body.data?.id ?? ''),
    await one(StudentDocument),
    await one(Post),
    await one(Subject),
    await one(Approval),
    await one(Notification),
    await one(Enquiry),
    await one(Application)
  ].filter(Boolean);
  const names = ['Pupil1 Result', 'Pupil2 Result', 'B news', 'B homework', String(fx.school._id), fx.school.slug, fx.school.name];
  void [Staff, Guardian, Student, Term, AcademicSession, ClassArm, ClassLevel];
  return { fx, ids: [...new Set(ids)], names };
}

const stub = (path: string, ids: string[], pick: number) =>
  path
    .replace(/:n\b/g, '2')
    .replace(/:key\b/g, 'invoice_issued')
    .replace(/:v\b/g, '1')
    .replace(/:code\b/g, 'ABCDEFGHJK')
    .replace(/:token\b/g, 'x'.repeat(30))
    .replace(/:kind\b/g, 'students')
    .replace(/:[A-Za-z]+/g, () => ids[pick % ids.length]);

const SKIP = (p: string) => p.startsWith('/api/v1/files/local') || p === '/api/v1/health';
const NOT_FOUND_ROUTE = 'That address does not exist.';

describe('tenancy: every tenant route, user of school A, IDs of school B', () => {
  it('walks the whole route table and never gets or changes anything from school B', async () => {
    const b = await seedB();
    const a = await buildSchool();
    const kid = await addStudent(a, { first: 'Aaron', guardianPhone: '08039990001' });
    await generateInvoices(a);
    const parentA = await parentLogin(a, kid.guardianId);
    const actors: Array<[string, any]> = [['owner of A', a.oc], ['bursar of A', a.bc], ['parent of A', parentA]];

    const tenant = routeRegistry.filter((r) => r.scope === 'tenant' && !SKIP(r.path));
    expect(tenant.length).toBeGreaterThan(200);
    const methodSet = new Set<string>();
    const leaks: string[] = [];
    const unmounted: string[] = [];
    const changed: string[] = [];
    let calls = 0;

    const baseline = async () => ({
      students: await ctxFor(String(b.fx.school._id), () => Student.countDocuments({})),
      invoices: await ctxFor(String(b.fx.school._id), () => Invoice.find({}).select('totalKobo paidKobo status').lean()),
      guardians: await ctxFor(String(b.fx.school._id), () => Guardian.countDocuments({})),
      staff: await ctxFor(String(b.fx.school._id), () => Staff.countDocuments({}))
    });
    const before = await baseline();

    for (const [label, c] of actors) {
      for (const route of tenant) {
        methodSet.add(route.method);
        const tries = route.hasIdParams ? b.ids.length : 1;
        for (let pick = 0; pick < tries; pick++) {
          const path = stub(route.path.replace('/api/v1', ''), b.ids, pick);
          const body: Record<string, string> = { studentId: b.ids[0], classArmId: b.fx.armA, subjectId: b.fx.subjects['English Language'], termId: b.fx.termId, invoiceId: b.ids[b.fx.kids.length * 2] };
          let req = (c as any)[route.method.toLowerCase()](path);
          if (route.method !== 'GET') req = req.set('Idempotency-Key', `tenancy-${calls}-${Math.random().toString(36).slice(2)}`).send(body);
          const res = await req;
          calls += 1;
          if (res.body?.error?.message === NOT_FOUND_ROUTE) unmounted.push(`${route.method} ${route.path}`);
          if (res.status >= 200 && res.status < 300) {
            const text = JSON.stringify(res.body);
            // an owner's list endpoints return A's own data. B's ids and names must not appear.
            for (const id of b.ids) if (text.includes(id)) leaks.push(`${label}: ${route.method} ${path} returned B id ${id}`);
            for (const n of b.names) if (n.length > 5 && text.includes(n) && n !== a.school.name) leaks.push(`${label}: ${route.method} ${path} returned "${n}"`);
          }
          // an id from B must never make an id route succeed (no 2xx), whatever the actor can normally do
          if (route.hasIdParams && res.status >= 200 && res.status < 300 && !/\/(me|my|tasks)\b/.test(route.path) && route.method !== 'GET') changed.push(`${label}: ${route.method} ${path} -> ${res.status}`);
          if (route.hasIdParams && res.status === 500) leaks.push(`${label}: ${route.method} ${path} -> 500`);
        }
      }
    }
    await drainJobs();
    expect(unmounted, 'routes in the table that are not mounted').toEqual([]);
    expect(leaks).toEqual([]);
    expect(changed).toEqual([]);
    expect(methodSet.has('GET') && methodSet.has('POST') && methodSet.has('PATCH') && methodSet.has('DELETE') && methodSet.has('PUT')).toBe(true);

    // and nothing of B changed
    const after = await baseline();
    expect(after.students).toBe(before.students);
    expect(after.guardians).toBe(before.guardians);
    expect(after.staff).toBe(before.staff);
    expect(after.invoices.map((i: any) => [i.totalKobo, i.paidKobo, i.status])).toEqual(before.invoices.map((i: any) => [i.totalKobo, i.paidKobo, i.status]));
    expect(calls).toBeGreaterThan(1500);
  }, 600_000);

  it('refuses every platform route to a school user, and every tenant route to someone not signed in', async () => {
    const a = await buildSchool();
    const platformRoutes = routeRegistry.filter((r) => r.scope === 'platform');
    expect(platformRoutes.length).toBeGreaterThan(25);
    for (const r of platformRoutes) {
      const path = r.path.replace('/api/v1', '').replace(/:[A-Za-z]+/g, a.levelId);
      let req = (a.oc as any)[r.method.toLowerCase()](path);
      if (r.method !== 'GET') req = req.set('Idempotency-Key', 'platform-block-0001').send({});
      const res = await req;
      expect([401, 403], `${r.method} ${r.path} -> ${res.status}`).toContain(res.status);
    }
    const anon = client(a.host);
    for (const r of routeRegistry.filter((x) => x.scope === 'tenant' && !SKIP(x.path))) {
      const path = r.path.replace('/api/v1', '').replace(/:n\b/g, '2').replace(/:key\b/g, 'invoice_issued').replace(/:v\b/g, '1').replace(/:kind\b/g, 'students').replace(/:[A-Za-z]+/g, a.levelId);
      let req = (anon as any)[r.method.toLowerCase()](path);
      if (r.method !== 'GET') req = req.set('Idempotency-Key', 'anon-block-0001').send({});
      const res = await req;
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  }, 300_000);

  it('gives a record from another school the same answer as a record that does not exist', async () => {
    const b = await seedB();
    const a = await buildSchool();
    const nowhere = '64b64b64b64b64b64b64b64b';
    for (const p of ['/students/:id', '/guardians/:id', '/invoices/:id', '/staff/:id', '/payments/:id', '/receipts/:id', '/applications/:id']) {
      const real = await a.oc.get(p.replace(':id', b.ids[0]));
      const none = await a.oc.get(p.replace(':id', nowhere));
      expect([real.status, real.body.error?.code]).toEqual([none.status, none.body.error?.code]);
    }
    void platform;
  }, 120_000);
});
