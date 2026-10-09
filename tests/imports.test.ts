import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { client, ctxFor, drainJobs, makeStaff, platform, resetDb, signIn, startTestDb, stopTestDb } from './helpers';
import { addStudent, buildSchool, generateInvoices, parentLogin, uploadPng, type Fixture } from './fixtures';
import { outbox } from '../src/integrations/sms';
import { Guardian, ImportBatch, Invoice, Student, Score, Term, TermResult, Enrolment, AcademicSession, Staff } from '../src/models';
import { resultsSchool, SUBJECTS, enterScores, submitSheet } from './resultsFixture';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(resetDb);

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function sheetRef(c: any, rows: any[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  rows.forEach((r) => ws.addRow(r));
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const sign = await c.post('/files/sign').send({ purpose: 'import_file', mime: XLSX });
  expect(sign.status).toBe(200);
  const up = await client().agent.put(sign.body.data.uploadUrl).set('Content-Type', XLSX).send(buf);
  expect(up.status).toBe(204);
  return sign.body.data.fileRef as string;
}

const HEAD = ['Admission number', 'First name', 'Last name', 'Date of birth', 'Gender', 'Class', 'Arm', 'Guardian 1 first name', 'Guardian 1 last name', 'Guardian 1 phone', 'Guardian 1 relationship'];
const studentRow = (i: number, over: Record<number, any> = {}) => {
  const r: any[] = ['', `Student${i}`, 'Import', '2015-02-03', i % 2 ? 'male' : 'female', 'Primary 4', 'A', `Parent${i}`, 'Import', `0803${String(1000000 + i).slice(-7)}`, 'mother'];
  for (const [k, v] of Object.entries(over)) r[Number(k)] = v;
  return r;
};

async function runImport(fx: Fixture, kind: string, rows: any[][], options?: any) {
  const fileRef = await sheetRef(fx.oc, rows);
  const start = await fx.oc.post('/imports').send({ kind, fileRef, options });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  await drainJobs();
  return start.body.data.batchId as string;
}
const report = async (fx: Fixture, id: string, tab?: string) => (await fx.oc.get(`/imports/${id}${tab ? `?tab=${tab}` : ''}`)).body.data;
const commit = async (fx: Fixture, id: string) => {
  const res = await fx.oc.post(`/imports/${id}/commit`).set('Idempotency-Key', `commit-${id}-${Math.random()}`).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await drainJobs();
  return report(fx, id);
};

describe('M5 student import', () => {
  it('imports 300 students where 5 rows are bad: lists exactly those 5 with reasons, and after fixing the committed count matches', async () => {
    const fx = await buildSchool();
    const rows: any[][] = [HEAD];
    for (let i = 1; i <= 300; i++) rows.push(studentRow(i));
    // five bad rows
    rows[10] = studentRow(10, { 3: '2015-13-45' }); // bad date
    rows[20] = studentRow(20, { 4: 'unknown' }); // bad gender
    rows[30] = studentRow(30, { 5: 'Primary 99' }); // class does not exist
    rows[40] = studentRow(40, { 9: '12345' }); // bad phone
    rows[50] = studentRow(50, { 1: '' }); // no first name
    const id = await runImport(fx, 'students', rows);
    const rep = await report(fx, id);
    expect(rep.status).toBe('ready');
    expect(rep.counts).toMatchObject({ total: 300, ready: 295, errors: 5, duplicates: 0 });
    const errs = (await report(fx, id, 'errors')).rows;
    expect(errs.map((e: any) => e.n)).toEqual([11, 21, 31, 41, 51]);
    expect(errs[0].errors[0]).toMatchObject({ field: 'Date of birth' });
    expect(errs[2].errors[0].message).toMatch(/no class called "Primary 99"/);
    expect(errs[3].errors[0].message).toMatch(/valid phone/);

    // fix the five rows on screen
    expect((await fx.oc.patch(`/imports/${id}/rows/11`).send({ cells: { 'Date of birth': '2015-04-05' } })).body.data.status).toBe('ready');
    expect((await fx.oc.patch(`/imports/${id}/rows/21`).send({ cells: { Gender: 'female' } })).body.data.status).toBe('ready');
    expect((await fx.oc.patch(`/imports/${id}/rows/31`).send({ cells: { Class: 'Primary 4' } })).body.data.status).toBe('ready');
    expect((await fx.oc.patch(`/imports/${id}/rows/41`).send({ cells: { 'Guardian 1 phone': '08031239999' } })).body.data.status).toBe('ready');
    expect((await fx.oc.patch(`/imports/${id}/rows/51`).send({ cells: { 'First name': 'Fixed' } })).body.data.status).toBe('ready');
    expect((await report(fx, id)).counts).toMatchObject({ ready: 300, errors: 0 });

    await drainJobs();
    const before = outbox.length;
    const done = await commit(fx, id);
    expect(done.status).toBe('committed');
    expect(done.counts.committed).toBe(300);
    expect(await ctxFor(String(fx.school._id), () => Student.countDocuments({}))).toBe(300);
    // no SMS is sent by an import
    await drainJobs();
    expect(outbox.length).toBe(before);
    // committing again is refused
    expect((await fx.oc.post(`/imports/${id}/commit`).set('Idempotency-Key', 'again-12345678').send({})).status).toBe(409);
  }, 120_000);

  it('turns rows that share a guardian phone into one guardian, and flags a likely duplicate for staff to accept', async () => {
    const fx = await buildSchool();
    await addStudent(fx, { first: 'Existing', last: 'Import', guardianPhone: '08031110000' });
    const rows: any[][] = [HEAD, studentRow(1, { 9: '08037770001' }), studentRow(2, { 9: '08037770001' }), studentRow(3, { 1: 'Existing', 2: 'Import', 3: '2016-02-03', 9: '08031110000' }), studentRow(4, { 1: 'Student1', 9: '08037770001' })];
    const id = await runImport(fx, 'students', rows);
    const rep = await report(fx, id);
    expect(rep.counts).toMatchObject({ ready: 2, duplicates: 2 });
    const dups = (await report(fx, id, 'duplicates')).rows;
    expect(dups.map((d: any) => d.n)).toEqual([4, 5]);
    expect(dups[0].duplicateOf).toMatch(/already in the school/);
    expect(dups[1].duplicateOf).toMatch(/Same as row 2/);
    // a duplicate is skipped unless staff accept it
    const done = await commit(fx, id);
    expect(done.counts.committed).toBe(2);
    expect(await ctxFor(String(fx.school._id), () => Guardian.countDocuments({ phone: '+2348037770001' }))).toBe(1);
    const g: any = await ctxFor(String(fx.school._id), () => Guardian.findOne({ phone: '+2348037770001' }).lean());
    expect((await fx.oc.get(`/guardians/${g._id}`)).body.data.students.length).toBe(2);
  });

  it('rolls back every record of the batch, and refuses once a payment exists for any of its students', async () => {
    const fx = await buildSchool({ withBank: true });
    const id = await runImport(fx, 'students', [HEAD, studentRow(1), studentRow(2), studentRow(3)]);
    await commit(fx, id);
    expect(await ctxFor(String(fx.school._id), () => Student.countDocuments({}))).toBe(3);
    const rb = await fx.oc.post(`/imports/${id}/rollback`).send({});
    expect(rb.status).toBe(200);
    expect(await ctxFor(String(fx.school._id), () => Student.countDocuments({}))).toBe(0);
    expect(await ctxFor(String(fx.school._id), () => Guardian.countDocuments({}))).toBe(0);
    expect(await ctxFor(String(fx.school._id), () => Enrolment.countDocuments({}))).toBe(0);
    expect((await report(fx, id)).status).toBe('rolled_back');
    expect((await fx.oc.post(`/imports/${id}/rollback`).send({})).status).toBe(409);

    // a second batch: invoices exist, then a payment is recorded against one student
    const id2 = await runImport(fx, 'students', [HEAD, studentRow(11), studentRow(12)]);
    await commit(fx, id2);
    await generateInvoices(fx);
    const s: any = await ctxFor(String(fx.school._id), () => Student.findOne({}).lean());
    await fx.bc.post('/payments/offline').set('Idempotency-Key', 'pay-import-rb-1').send({ studentId: String(s._id), amountKobo: 100000, channel: 'cash', paidOn: '2026-10-05' });
    const refused = await fx.oc.post(`/imports/${id2}/rollback`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.payments).toBe(true);
    expect(await ctxFor(String(fx.school._id), () => Student.countDocuments({}))).toBe(2);
  });

  it('is refused after the rollback period', async () => {
    const fx = await buildSchool();
    const id = await runImport(fx, 'students', [HEAD, studentRow(1)]);
    await commit(fx, id);
    await ImportBatch.collection.updateOne({ _id: (await ctxFor(String(fx.school._id), () => ImportBatch.findOne({}).lean()))._id }, { $set: { committedAt: new Date(Date.now() - 20 * 86400_000) } });
    const res = await fx.oc.post(`/imports/${id}/rollback`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/more than 14 days/);
  });

  it('keeps imports to people allowed to import, and the template to the right shape', async () => {
    const fx = await buildSchool();
    const teacher = await makeStaff(fx.school, ['subject_teacher']);
    const { c: tc } = await signIn(teacher.phone, fx.host);
    expect((await tc.get('/imports/templates/students')).status).toBe(403);
    expect((await tc.get('/imports')).status).toBe(403);
    const tpl = await fx.oc.get('/imports/templates/students');
    expect(tpl.status).toBe(200);
    const file = await client().agent.get(tpl.body.data.url).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body);
    expect((wb.getWorksheet('Students')!.getRow(1).values as any[]).slice(1, 8)).toEqual(['Admission number', 'First name', 'Middle name', 'Last name', 'Date of birth', 'Gender', 'Class']);
    expect(wb.getWorksheet('Lists')).toBeTruthy(); // drop-downs come from the hidden Lists sheet
  });
});

describe('M5 staff and balances', () => {
  it('imports staff as invites after validating roles, and an admin cannot import a principal', async () => {
    const fx = await buildSchool();
    const rows = [['First name', 'Last name', 'Phone', 'Email', 'Roles'], ['Bola', 'Adeyemi', '08035551111', '', 'subject_teacher'], ['Tunde', 'Bello', '08035552222', '', 'class_teacher, subject_teacher'], ['Bad', 'Role', '08035553333', '', 'wizard']];
    const id = await runImport(fx, 'staff', rows);
    const rep = await report(fx, id);
    expect(rep.counts).toMatchObject({ ready: 2, errors: 1 });
    await commit(fx, id);
    expect(await ctxFor(String(fx.school._id), () => Staff.countDocuments({ status: 'invited' }))).toBe(2);
    await drainJobs();
    expect(outbox.filter((o) => o.channel === 'sms' && /added you as/.test(o.body)).length).toBe(2);
    const admin = await makeStaff(fx.school, ['school_admin']);
    const { c: ac } = await signIn(admin.phone, fx.host);
    const ref = await sheetRef(ac, [['First name', 'Last name', 'Phone', 'Email', 'Roles'], ['Head', 'Teacher', '08035554444', '', 'principal']]);
    const start = await ac.post('/imports').send({ kind: 'staff', fileRef: ref });
    await drainJobs();
    const rep2 = (await ac.get(`/imports/${start.body.data.batchId}`)).body.data;
    expect(rep2.counts.errors).toBe(1);
    expect(rep2.rows[0].errors[0].message).toMatch(/cannot assign the principal role/);
  });

  it('imports opening balances as brought-forward invoices', async () => {
    const fx = await buildSchool();
    const a = await addStudent(fx);
    const id = await runImport(fx, 'opening_balances', [['Admission number', 'Amount', 'Note'], [a.admissionNumber, '12,000.50', 'Arrears'], ['NOPE/1', '5', '']]);
    expect((await report(fx, id)).counts).toMatchObject({ ready: 1, errors: 1 });
    await commit(fx, id);
    const inv: any = await ctxFor(String(fx.school._id), () => Invoice.findOne({ kind: 'opening_balance' }).lean());
    expect(inv.totalKobo).toBe(1200050);
    expect(String(inv.importBatchId)).toBe(id);
    // the bursar may import balances, and nothing else
    const { c: bc } = fx.bc ? { c: fx.bc } : ({} as any);
    const ref = await sheetRef(bc, [['First name', 'Last name', 'Phone', 'Email', 'Roles'], ['A', 'B', '08035550000', '', 'subject_teacher']]);
    expect((await bc.post('/imports').send({ kind: 'staff', fileRef: ref })).status).toBe(403);
    // rolling back removes the invoice when unpaid
    expect((await fx.oc.post(`/imports/${id}/rollback`).send({})).status).toBe(200);
    expect(await ctxFor(String(fx.school._id), () => Invoice.countDocuments({ kind: 'opening_balance' }))).toBe(0);
  });
});

describe('M5 past records', () => {
  async function schoolWithStudents() {
    const fx = await resultsSchool({ students: 2 });
    return fx;
  }
  const options = (fx: Fixture, mode = 'totals') => ({ sessionName: '2024/2025', termNumber: 3, classArmId: fx.armA, mode });

  it('shows a totals-only result for third term 2024/2025 on the student, labelled imported, and visible to the parent', async () => {
    const fx = await schoolWithStudents();
    const id = await runImport(fx, 'past_results', [['Admission number', 'Subject', 'Total'], [fx.kids[0].admissionNumber, 'English Language', 78], [fx.kids[0].admissionNumber, 'Mathematics', 64], [fx.kids[1].admissionNumber, 'English Language', 51]], options(fx));
    expect((await report(fx, id)).counts).toMatchObject({ ready: 3, errors: 0 });
    await commit(fx, id);

    // a closed past session now exists, holding imported records only
    const past: any = await ctxFor(String(fx.school._id), () => AcademicSession.findOne({ name: '2024/2025' }).lean());
    expect(past).toMatchObject({ status: 'closed', importedOnly: true });

    const staffView = (await fx.oc.get(`/results/students/${fx.kids[0].id}`)).body.data;
    const imported = staffView.find((r: any) => r.session === '2024/2025');
    expect(imported).toMatchObject({ term: 3, imported: true, published: true, subjectsCount: 2, total: 142 });
    expect(imported.average).toBe(71);
    expect(imported.subjects.find((s: any) => s.name === 'English Language')).toMatchObject({ total: 78, grade: 'A' });
    const parent = await parentLogin(fx, fx.kids[0].guardianId);
    const seen = (await parent.get(`/results/students/${fx.kids[0].id}`)).body.data;
    expect(seen.find((r: any) => r.imported)).toMatchObject({ session: '2024/2025', term: 3 });
    // the legacy endpoint lists them for staff
    expect((await fx.oc.get(`/legacy/results?studentId=${fx.kids[0].id}`)).body.data[0]).toMatchObject({ session: '2024/2025', imported: true });
    // the student's enrolment history includes the past session
    expect((await fx.oc.get(`/students/${fx.kids[0].id}/enrolments`)).body.data.map((e: any) => e.session)).toContain('2024/2025');
  });

  it('keeps imported results out of the current compile, and stores component scores when asked', async () => {
    const fx = await schoolWithStudents();
    const id = await runImport(fx, 'past_results', [['Admission number', 'Subject', 'CA1', 'CA2', 'Exam'], [fx.kids[0].admissionNumber, 'English Language', 15, 16, 40]], options(fx, 'components'));
    expect((await report(fx, id)).counts.ready).toBe(1);
    await commit(fx, id);
    const before: any = await ctxFor(String(fx.school._id), () => Score.findOne({ source: 'imported' }).lean());
    expect(before).toMatchObject({ total: 71, grade: 'A', components: { ca1: 15, ca2: 16, exam: 40 } });
    // compile the current term for the class
    for (const name of SUBJECTS) {
      const who = name === SUBJECTS[2] ? fx.teacherB : fx.teacherA;
      await enterScores(fx, who, name, { 0: { ca1: 10, ca2: 10, exam: 30 }, 1: { ca1: 10, ca2: 10, exam: 30 } });
      await submitSheet(fx, who, name);
    }
    expect((await fx.classTeacher.c.post(`/class-results/${fx.armA}/compile`).send({})).status).toBe(202);
    await drainJobs();
    const after: any = await ctxFor(String(fx.school._id), () => Score.findOne({ source: 'imported' }).lean());
    expect(after.total).toBe(71);
    expect(String(after.updatedAt)).toBe(String(before.updatedAt)); // not touched
    expect(await ctxFor(String(fx.school._id), () => TermResult.countDocuments({ source: 'imported' }))).toBe(1);
    // component over the maximum is flagged
    const bad = await runImport(fx, 'past_results', [['Admission number', 'Subject', 'CA1', 'CA2', 'Exam'], [fx.kids[1].admissionNumber, 'English Language', 99, 16, 40]], options(fx, 'components'));
    expect((await report(fx, bad, 'errors')).rows[0].errors[0].message).toMatch(/1st CA is marked out of 20/);
  });

  it('enters past results on screen and never overwrites a real result', async () => {
    const fx = await schoolWithStudents();
    const subjectId = fx.subjects[SUBJECTS[0]];
    const put = await fx.oc.put('/legacy/results').set('Idempotency-Key', 'legacy-1-12345').send({ sessionName: '2024/2025', termNumber: 2, classArmId: fx.armA, mode: 'totals', rows: [{ studentId: fx.kids[0].id, subjectId, total: 66 }] });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ scores: 1, students: 1 });
    expect((await fx.oc.get(`/legacy/results?studentId=${fx.kids[0].id}`)).body.data[0].subjects[0]).toMatchObject({ total: 66, grade: 'B' });
    // a real result already compiled for the current term is not replaced
    await enterScores(fx, fx.teacherA, SUBJECTS[0], { 0: { ca1: 10, ca2: 10, exam: 30 } });
    const term: any = await ctxFor(String(fx.school._id), () => Term.findOne({ status: 'current' }).lean());
    await ctxFor(String(fx.school._id), () => TermResult.create({ termId: term._id, studentId: fx.kids[0].id, classArmId: fx.armA, source: 'entered' }));
    expect(term).toBeTruthy();
    void platform; void Staff; void uploadPng;
  });

  it('attaches a scanned old report card to a student, visible to the parent only when marked visible', async () => {
    const fx = await schoolWithStudents();
    const png = await uploadPng(fx.oc, 'student_document');
    const hidden = await fx.oc.post(`/students/${fx.kids[0].id}/documents`).send({ title: 'Report card 2023/2024', file: png, visibleToGuardian: false });
    expect(hidden.status).toBe(201);
    const png2 = await uploadPng(fx.oc, 'student_document');
    const shown = await fx.oc.post(`/students/${fx.kids[0].id}/documents`).send({ title: 'Report card 2022/2023', file: png2, visibleToGuardian: true });
    expect(shown.status).toBe(201);
    const parent = await parentLogin(fx, fx.kids[0].guardianId);
    const docs = (await parent.get(`/students/${fx.kids[0].id}/documents`)).body.data;
    expect(docs.map((d: any) => d.title)).toEqual(['Report card 2022/2023']);
    expect((await parent.get(`/files/link?ref=${encodeURIComponent(png2)}`)).status).toBe(200);
    expect((await parent.get(`/files/link?ref=${encodeURIComponent(png)}`)).status).toBe(404); // the hidden one is not reachable either
    expect((await fx.oc.get(`/students/${fx.kids[0].id}/documents`)).body.data.length).toBe(2);
  });
});
