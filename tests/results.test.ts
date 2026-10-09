import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { client, ctxFor, drainJobs, hostOf, makeStaff, platform, PASSWORD, resetDb, signIn, smsTo, startTestDb, stopTestDb } from './helpers';
import { addStudent, generateInvoices, parentLogin, uploadPng } from './fixtures';
import { enterScores, fillAllSheets, resultsSchool, submitSheet, SUBJECTS, type ResultsFixture } from './resultsFixture';
import { AcademicSession, AuditLog, Enrolment, Score, SmsWallet, Staff, Student, TermResult } from '../src/models';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(resetDb);

const ENG = SUBJECTS[0];
const MTH = SUBJECTS[1];
const SCI = SUBJECTS[2];

/** compile and wait */
const giveUnits = (fx: ResultsFixture, units = 100) => ctxFor(String(fx.school._id), () => SmsWallet.updateOne({}, { $set: { units } }, { upsert: true }));

async function staffIdOf(userId: string, fx: ResultsFixture) {
  return String((await ctxFor(String(fx.school._id), () => Staff.findOne({ userId }).lean()))._id);
}

async function compile(fx: ResultsFixture, who = fx.classTeacher) {
  const res = await who.c.post(`/class-results/${fx.armA}/compile`).send({});
  if (res.status !== 202) return res;
  await drainJobs();
  return res;
}
const view = async (fx: ResultsFixture, who: { c: any } = fx.classTeacher) => (await who.c.get(`/class-results/${fx.armA}`)).body.data;

async function publishAll(fx: ResultsFixture, scoreFor: (k: number, s: string) => { ca1: number; ca2: number; exam: number } = () => ({ ca1: 15, ca2: 15, exam: 45 })) {
  await fillAllSheets(fx, scoreFor);
  expect((await compile(fx)).status).toBe(202);
  expect((await fx.classTeacher.c.post(`/class-results/${fx.armA}/submit`).send({})).status).toBe(200);
  expect((await fx.principal.c.post(`/class-results/${fx.armA}/approve`).send({})).status).toBe(200);
  const pub = await fx.principal.c.post(`/class-results/${fx.armA}/publish`).send({});
  expect(pub.status).toBe(202);
  await drainJobs();
}

describe('M12 score entry', () => {
  it('refuses a score above the component maximum and states the maximum, saving nothing', async () => {
    const fx = await resultsSchool();
    const res = await fx.teacherA.c.patch(`/score-sheets/${fx.armA}/${fx.subjects[ENG]}`).send({ cells: [{ studentId: fx.kids[0].id, component: 'ca1', score: 15 }, { studentId: fx.kids[0].id, component: 'exam', score: 61 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.fields['cells[1].score']).toBe('Exam is marked out of 60.');
    const grid = (await fx.teacherA.c.get(`/score-sheets/${fx.armA}/${fx.subjects[ENG]}`)).body.data;
    expect(grid.students[0].components).toEqual({}); // the valid cell in the same request was not saved either
    expect((await enterScores(fx, fx.teacherA, ENG, { 0: { ca1: 14.25 } })).status).toBe(422); // one decimal place only
    expect((await enterScores(fx, fx.teacherA, ENG, { 0: { ca1: -1 } })).status).toBe(422);
  });

  it('saves partial cells (autosave), returns totals and grades, and is safe to repeat', async () => {
    const fx = await resultsSchool();
    const a = await enterScores(fx, fx.teacherA, ENG, { 0: { ca1: 15, ca2: 14.5, exam: 48 } });
    expect(a.status).toBe(200);
    expect(a.body.data.saved).toBe(3);
    expect(a.body.data.rows[0]).toMatchObject({ total: 77.5, grade: 'A', complete: true });
    const again = await enterScores(fx, fx.teacherA, ENG, { 0: { ca1: 15, ca2: 14.5, exam: 48 } });
    expect(again.body.data.rows[0].total).toBe(77.5);
    const partial = await enterScores(fx, fx.teacherA, ENG, { 1: { ca1: 10 } });
    expect(partial.body.data.rows[0]).toMatchObject({ total: null, complete: false });
  });

  it('keeps a teacher to their own class and subject', async () => {
    const fx = await resultsSchool();
    // teacher B does not teach English
    expect((await enterScores(fx, fx.teacherB, ENG, { 0: { ca1: 10 } })).status).toBe(403);
    expect((await fx.teacherB.c.get(`/score-sheets/${fx.armA}/${fx.subjects[ENG]}`)).status).toBe(404);
    expect((await fx.teacherB.c.get(`/score-sheets?classArmId=${fx.armA}`)).body.data.sheets.map((s: any) => s.subject)).toEqual([SCI]);
    // the class teacher sees every sheet of the class
    expect((await fx.classTeacher.c.get(`/score-sheets?classArmId=${fx.armA}`)).body.data.sheets.length).toBe(3);
    // a parent cannot touch score sheets at all
    const parent = await parentLogin(fx, fx.kids[0].guardianId);
    expect((await parent.get(`/score-sheets?classArmId=${fx.armA}`)).status).toBe(403);
  });

  it('blocks submitting a sheet with empty unflagged cells and lists them, then accepts absent and exempt flags', async () => {
    const fx = await resultsSchool({ students: 3 });
    await enterScores(fx, fx.teacherA, MTH, { 0: { ca1: 12, exam: 39 }, 1: { ca1: 10, ca2: 10, exam: 40 } });
    const blocked = await submitSheet(fx, fx.teacherA, MTH);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('incomplete_scores');
    const m = blocked.body.error.details.missing;
    expect(m.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Pupil1 Result', 'Pupil3 Result']));
    expect(m.find((x: any) => x.name === 'Pupil1 Result').columns).toEqual(['ca2']);
    // fix: ABS for pupil 1's second CA, pupil 3 exempt
    await enterScores(fx, fx.teacherA, MTH, { 0: { ca2: 'ABS' }, 2: 'EXEMPT' });
    const ok = await submitSheet(fx, fx.teacherA, MTH);
    expect(ok.status).toBe(200);
    // a submitted sheet is read-only for the teacher
    expect((await enterScores(fx, fx.teacherA, MTH, { 1: { exam: 41 } })).status).toBe(409);
  });

  it('fills a sheet from the spreadsheet template and reports bad rows without saving anything', async () => {
    const fx = await resultsSchool({ students: 2 });
    const book = async (rows: any[][]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Scores');
      rows.forEach((r) => ws.addRow(r));
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    // the bursar/admin-style import purpose is not for teachers, so the upload goes through the admin purpose
    const admin = await makeStaff(fx.school, ['school_admin']);
    const { c: ac } = await signIn(admin.phone, hostOf(fx.school));
    const send = async (buf: Buffer) => {
      const sign = await ac.post('/files/sign').send({ purpose: 'import_file', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const up = await client().agent.put(sign.body.data.uploadUrl).set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
      expect(up.status).toBe(204);
      return sign.body.data.fileRef as string;
    };
    await fx.oc.patch(`/staff/${admin.staff._id}`).send({});
    await fx.oc.put(`/staff/${admin.staff._id}/roles`).send({ roles: ['school_admin'], extraPermissions: ['scores.enter'] });
    await ac.post('/auth/refresh').send({});
    const good = await book([['Admission number', 'Name', 'ca1', 'ca2', 'exam'], [fx.kids[0].admissionNumber, 'x', 15, 14, 'ABS'], [fx.kids[1].admissionNumber, 'y', 18, 17, 51]]);
    const goodRef = await send(good);
    const res = await ac.post(`/score-sheets/${fx.armA}/${fx.subjects[SCI]}/upload`).send({ fileRef: goodRef });
    expect(res.status).toBe(200);
    const grid = (await fx.teacherB.c.get(`/score-sheets/${fx.armA}/${fx.subjects[SCI]}`)).body.data;
    expect(grid.students[1]).toMatchObject({ total: 86, grade: 'A', onBehalf: true }); // typed by an admin on behalf of the subject teacher
    expect(grid.students[0].absent).toEqual(['exam']);
    expect((await platform(() => AuditLog.find({ action: 'scores.enter_on_behalf' }).lean())).length).toBe(1);
    // the teacher still submits it
    expect((await submitSheet(fx, fx.teacherB, SCI)).status).toBe(200);
    expect((await ac.post(`/score-sheets/${fx.armA}/${fx.subjects[SCI]}/submit`).send({})).status).toBe(403);

    const bad = await book([['Admission number', 'ca1'], ['NOPE/1', 5]]);
    const badRef = await send(bad);
    const rejected = await ac.post(`/score-sheets/${fx.armA}/${fx.subjects[ENG]}/upload`).send({ fileRef: badRef });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.details.errors[0].message).toMatch(/not on this class list/);
  });
});

describe('M12 results', () => {
  it('reproduces the worked example: 214.5 total, 71.50 average, Fine Art exempt', async () => {
    const fx = await resultsSchool({ students: 1, subjects: [ENG, MTH, SCI, 'Civic Education'] });
    const art = 'Civic Education'; // stands in for Fine Art: exempt
    await enterScores(fx, fx.teacherA, ENG, { 0: { ca1: 15, ca2: 14.5, exam: 48 } });
    await submitSheet(fx, fx.teacherA, ENG);
    await enterScores(fx, fx.classTeacher, MTH, { 0: { ca1: 12, ca2: 'ABS', exam: 39 } }); // with four subjects the fixture gives Mathematics to the class teacher
    await submitSheet(fx, fx.classTeacher, MTH);
    await enterScores(fx, fx.teacherB, SCI, { 0: { ca1: 18, ca2: 17, exam: 51 } });
    await submitSheet(fx, fx.teacherB, SCI);
    // the Civic Education sheet goes to teacher A in the fixture, but it is exempt
    const civic = await enterScores(fx, fx.teacherA, art, { 0: 'EXEMPT' });
    expect(civic.status).toBe(200);
    await submitSheet(fx, fx.teacherA, art);
    expect((await compile(fx)).status).toBe(202);
    const v = await view(fx);
    expect(v.status).toBe('compiled');
    expect(v.students[0]).toMatchObject({ subjectsCount: 3, total: 214.5 });
    expect(v.students[0].average).toBeCloseTo(71.5, 10);
    expect(v.students[0].position).toBe(1);
  });

  it('blocks compiling while sheets are outstanding and lists them; the class teacher sees which; returning a sheet reopens it', async () => {
    const fx = await resultsSchool({ students: 2 });
    await fillAllSheets(fx, () => ({ ca1: 10, ca2: 10, exam: 30 }));
    // pull one sheet back
    expect((await fx.classTeacher.c.post(`/score-sheets/${fx.armA}/${fx.subjects[MTH]}/return`).send({})).status).toBe(422); // note required
    const back = await fx.classTeacher.c.post(`/score-sheets/${fx.armA}/${fx.subjects[MTH]}/return`).send({ note: 'Check Pupil2 exam' });
    expect(back.status).toBe(200);
    const status = (await fx.classTeacher.c.get(`/score-sheets?classArmId=${fx.armA}`)).body.data;
    expect(status.outstanding).toBe(1);
    expect(status.sheets.find((s: any) => s.subject === MTH)).toMatchObject({ status: 'returned', returnNote: 'Check Pupil2 exam' });
    const blocked = await fx.classTeacher.c.post(`/class-results/${fx.armA}/compile`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('incomplete_scores');
    expect(blocked.body.error.details.outstandingSheets.map((s: any) => s.subject)).toEqual([MTH]);
    // the teacher is told, edits and resubmits
    await drainJobs();
    expect((await enterScores(fx, fx.teacherA, MTH, { 1: { exam: 35 } })).status).toBe(200);
    expect((await submitSheet(fx, fx.teacherA, MTH)).status).toBe(200);
    expect((await compile(fx)).status).toBe(202);
  });

  it('gives tied averages the positions 1, 2, 2, 4 and stores unrounded averages', async () => {
    const fx = await resultsSchool({ students: 4 });
    const totals = [78.4, 75, 75, 71.2];
    await fillAllSheets(fx, (k) => {
      const t = totals[k];
      const exam = Math.min(60, Math.round((t - 20) * 10) / 10);
      return { ca1: 10, ca2: 10, exam };
    });
    await compile(fx);
    const v = await view(fx);
    expect(v.students.map((s: any) => s.position)).toEqual([1, 2, 2, 4]);
    expect(v.students[0].classSize).toBe(4);
  });

  it('turns positions off for a level group: none are calculated or shown anywhere', async () => {
    const fx = await resultsSchool({ students: 2 });
    const groups = (await fx.oc.get('/level-groups')).body.data;
    await fx.oc.patch(`/level-groups/${groups[0].id}`).send({ showPositions: false });
    await fillAllSheets(fx, (k) => ({ ca1: 10 + k, ca2: 10, exam: 30 }));
    await compile(fx);
    const v = await view(fx);
    expect(v.showPositions).toBe(false);
    expect(v.students.every((s: any) => s.position === null)).toBe(true);
    const scores: any[] = await ctxFor(String(fx.school._id), () => Score.find({}).lean());
    expect(scores.every((s) => s.subjectPosition === null || s.subjectPosition === undefined)).toBe(true);
  });

  it('runs the approval chain: submit, approve, publish; report cards are generated, and parents are notified', async () => {
    const fx = await resultsSchool({ students: 3 });
    await giveUnits(fx);
    // only the class teacher or principal may drive it
    await fillAllSheets(fx, (k) => ({ ca1: 10 + k, ca2: 12, exam: 40 }));
    await compile(fx);
    expect((await fx.teacherA.c.post(`/class-results/${fx.armA}/submit`).send({})).status).toBe(403);
    expect((await fx.classTeacher.c.post(`/class-results/${fx.armA}/approve`).send({})).status).toBe(403);
    expect((await fx.classTeacher.c.post(`/class-results/${fx.armA}/submit`).send({})).status).toBe(200);
    expect((await fx.classTeacher.c.post(`/class-results/${fx.armA}/publish`).send({})).status).toBe(403);
    expect((await fx.principal.c.post(`/class-results/${fx.armA}/publish`).send({})).status).toBe(409); // not approved yet
    // the principal rejects once with a note, the class teacher fixes and resubmits
    expect((await fx.principal.c.post(`/class-results/${fx.armA}/reject`).send({ note: 'Add comments' })).status).toBe(200);
    expect((await view(fx)).status).toBe('open');
    expect((await view(fx)).rejectNote).toBe('Add comments');
    await compile(fx);
    await fx.classTeacher.c.post(`/class-results/${fx.armA}/submit`).send({});
    const approve = await fx.principal.c.post(`/class-results/${fx.armA}/approve`).send({});
    expect(approve.body.data.enteredAndApprovedBySame).toBe(false);
    // while approved, edits are locked
    expect((await fx.teacherA.c.patch(`/score-sheets/${fx.armA}/${fx.subjects[ENG]}`).send({ cells: [{ studentId: fx.kids[0].id, component: 'ca1', score: 1 }] })).status).toBe(409);
    const pub = await fx.principal.c.post(`/class-results/${fx.armA}/publish`).send({});
    expect(pub.status).toBe(202);
    await drainJobs();
    expect((await view(fx)).status).toBe('published');

    const cards = await fx.classTeacher.c.get(`/class-results/${fx.armA}/report-cards`);
    expect(cards.status).toBe(200);
    const merged = await client().agent.get(cards.body.data.url);
    expect(Buffer.from(merged.body).subarray(0, 4).toString()).toBe('%PDF');
    expect(await smsTo('+2348032001000', /result for Pupil1 Result is ready/)).toBeTruthy();
  });

  it('shows the parent the published result and report card, and keeps another family out', async () => {
    const fx = await resultsSchool({ students: 2 });
    await publishAll(fx);
    const p0 = await parentLogin(fx, fx.kids[0].guardianId);
    const p1 = await parentLogin(fx, fx.kids[1].guardianId);
    const res = (await p0.get(`/results/students/${fx.kids[0].id}`)).body.data;
    expect(res.length).toBe(1);
    expect(res[0]).toMatchObject({ term: 1, published: true, subjectsCount: 3, blocked: false });
    expect(res[0].subjects.map((s: any) => s.name).sort()).toEqual([...SUBJECTS].sort());
    expect(res[0].subjects[0]).toHaveProperty('grade');
    const link = await p0.get(`/results/students/${fx.kids[0].id}/report-card`);
    expect(link.status).toBe(200);
    const pdf = await client().agent.get(link.body.data.url);
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe('%PDF');
    // another family cannot fetch it
    expect((await p1.get(`/results/students/${fx.kids[0].id}`)).status).toBe(404);
    expect((await p1.get(`/results/students/${fx.kids[0].id}/report-card`)).status).toBe(404);
    // the report card's code validates on the public page
    const code = res[0].verificationCode;
    const verify = await client(fx.host).get(`/public/verify/${code}`);
    expect(verify.body.data).toMatchObject({ found: true, type: 'report_card', status: 'valid', studentName: 'Pupil1 Result' });
  });

  it('reopens with a reason, marks the revised card with the date, and updates other students’ positions', async () => {
    const fx = await resultsSchool({ students: 3 });
    await giveUnits(fx);
    await publishAll(fx, (k) => ({ ca1: 10 + k * 2, ca2: 10, exam: 30 }));
    const before = await view(fx);
    expect(before.students.map((s: any) => s.position)).toEqual([3, 2, 1]);
    expect((await fx.principal.c.post(`/class-results/${fx.armA}/reopen`).send({})).status).toBe(422);
    const re = await fx.principal.c.post(`/class-results/${fx.armA}/reopen`).send({ reason: 'Pupil1 exam was entered wrongly' });
    expect(re.status).toBe(200);
    expect((await view(fx)).status).toBe('reopened');
    // sheets are back with their teachers
    const sheets = (await fx.classTeacher.c.get(`/score-sheets?classArmId=${fx.armA}`)).body.data.sheets;
    expect(sheets.every((s: any) => s.status === 'returned')).toBe(true);
    // the teacher corrects: Pupil1 now beats everyone in English, Maths and Science
    for (const [subject, who] of [[ENG, fx.teacherA], [MTH, fx.teacherA], [SCI, fx.teacherB]] as const) {
      expect((await enterScores(fx, who, subject, { 0: { exam: 60 } })).status).toBe(200);
      expect((await submitSheet(fx, who, subject)).status).toBe(200);
    }
    await compile(fx);
    await fx.classTeacher.c.post(`/class-results/${fx.armA}/submit`).send({});
    await fx.principal.c.post(`/class-results/${fx.armA}/approve`).send({});
    await fx.principal.c.post(`/class-results/${fx.armA}/publish`).send({});
    await drainJobs();
    const after = await view(fx);
    expect(after.revision).toBe(1);
    expect(after.students.map((s: any) => s.position)).toEqual([1, 3, 2]); // others' positions moved
    expect(after.students[0].revision).toBe(1);
    const p = await parentLogin(fx, fx.kids[1].guardianId);
    expect((await p.get(`/results/students/${fx.kids[1].id}`)).body.data[0].revision).toBe(1);
    expect(await smsTo('+2348032001001', /revised/)).toBeTruthy();
    // the earlier card is kept and marked superseded
    const tr: any = await ctxFor(String(fx.school._id), () => TermResult.findOne({ studentId: fx.kids[0].id }).lean());
    expect(tr.reportCard.superseded.length).toBe(1);
    expect((await platform(() => AuditLog.find({ action: 'results.reopen' }).lean()))[0].reason).toMatch(/entered wrongly/);
  });

  it('says so when one person compiled and approved the same result, and audits both acts', async () => {
    const fx = await resultsSchool({ students: 2 });
    // the principal is also the class teacher, as in a small school
    await fx.oc.put('/teaching-assignments').send({ items: [{ classArmId: fx.armA, staffId: await staffIdOf(fx.principal.userId, fx), kind: 'class_teacher' }] });
    await fx.principal.c.post('/auth/refresh').send({});
    await fillAllSheets(fx, () => ({ ca1: 10, ca2: 10, exam: 30 }));
    expect((await compile(fx, fx.principal as any)).status).toBe(202);
    expect((await fx.principal.c.post(`/class-results/${fx.armA}/submit`).send({})).status).toBe(200);
    const approve = await fx.principal.c.post(`/class-results/${fx.armA}/approve`).send({});
    expect(approve.status).toBe(200);
    expect(approve.body.data.enteredAndApprovedBySame).toBe(true);
    expect((await view(fx, fx.principal as any)).sameHandsNotice).toBe(true);
    const logs = await platform(() => AuditLog.find({ action: { $in: ['results.compile', 'results.submit', 'results.approve', 'results.approve.same_person'] } }).lean());
    expect(logs.map((l: any) => l.action).sort()).toEqual(['results.approve', 'results.approve.same_person', 'results.compile', 'results.submit']);
  });
});

describe('M12 fee block and the closed term', () => {
  it('shows the parent a notice with the amount while the fee block is on; staff still see the result; staff can lift it', async () => {
    const fx = await resultsSchool({ students: 2 });
    await generateInvoices(fx);
    await fx.oc.patch('/school').send({ settings: { resultBlock: { enabled: true, thresholdKobo: 100000 } } });
    await publishAll(fx);
    const p = await parentLogin(fx, fx.kids[0].guardianId);
    const blocked = (await p.get(`/results/students/${fx.kids[0].id}`)).body.data[0];
    expect(blocked).toMatchObject({ blocked: true, balanceKobo: 5200000 });
    expect(blocked.message).toMatch(/Pay ₦52,000\.00/);
    expect(blocked.subjects).toBeUndefined();
    const card = await p.get(`/results/students/${fx.kids[0].id}/report-card`);
    expect(card.status).toBe(403);
    // staff still see the result
    expect((await fx.classTeacher.c.get(`/results/students/${fx.kids[0].id}`)).body.data[0].subjects.length).toBe(3);
    // the bursar lifts it for this student only
    expect((await fx.bc.post(`/results/students/${fx.kids[0].id}/unblock`).send({})).status).toBe(200);
    expect((await p.get(`/results/students/${fx.kids[0].id}`)).body.data[0].blocked).toBe(false);
    expect((await p.get(`/results/students/${fx.kids[0].id}/report-card`)).status).toBe(200);
    const p2 = await parentLogin(fx, fx.kids[1].guardianId);
    expect((await p2.get(`/results/students/${fx.kids[1].id}`)).body.data[0].blocked).toBe(true);
    // paying clears the block without staff help
    await fx.bc.post('/payments/offline').set('Idempotency-Key', 'pay-off-block-12').send({ studentId: fx.kids[1].id, amountKobo: 5200000, channel: 'cash', paidOn: '2026-10-05' });
    expect((await p2.get(`/results/students/${fx.kids[1].id}`)).body.data[0].blocked).toBe(false);
  });

  it('returns term_closed when saving a score in a closed term, and saves again once the principal reopens the term with a reason', async () => {
    const fx = await resultsSchool({ students: 1 });
    expect((await enterScores(fx, fx.teacherA, ENG, { 0: { ca1: 10 } })).status).toBe(200);
    await fx.principal.c.post(`/terms/${fx.termId}/close`).send({});
    const closed = await enterScores(fx, fx.teacherA, ENG, { 0: { ca1: 11 } });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('term_closed');
    expect((await fx.principal.c.post(`/terms/${fx.termId}/reopen`).send({})).status).toBe(422);
    expect((await fx.principal.c.post(`/terms/${fx.termId}/reopen`).send({ reason: 'Late correction' })).status).toBe(200);
    expect((await enterScores(fx, fx.teacherA, ENG, { 0: { ca1: 11 } })).status).toBe(200);
  });
});

describe('M12 ratings, comments and the broadsheet', () => {
  it('saves behaviour ratings and comments with a comment bank suggestion the teacher can edit, and keeps comments to their authors', async () => {
    const fx = await resultsSchool({ students: 2 });
    const traits = (await fx.oc.get('/traits?category=behaviour')).body.data;
    expect(traits.length).toBeGreaterThan(0);
    const t0 = traits[0];
    const saved = await fx.classTeacher.c.put(`/class-results/${fx.armA}/ratings`).send({ items: [{ studentId: fx.kids[0].id, ratings: [{ traitId: t0._id, value: 5 }] }] });
    expect(saved.status).toBe(200);
    expect((await fx.classTeacher.c.put(`/class-results/${fx.armA}/ratings`).send({ items: [{ studentId: fx.kids[0].id, ratings: [{ traitId: t0._id, value: 9 }] }] })).status).toBe(422);
    expect((await fx.teacherA.c.put(`/class-results/${fx.armA}/ratings`).send({ items: [] })).status).toBe(403);
    await fillAllSheets(fx, (k) => ({ ca1: 18, ca2: 18, exam: 54 - k * 30 }));
    await compile(fx);
    const sug = (await fx.classTeacher.c.get(`/class-results/${fx.armA}/comment-suggestions`)).body.data;
    expect(sug[0].teacher).toMatch(/outstanding|brilliant/i);
    expect(sug[1].teacher).toBeTruthy();
    expect((await fx.classTeacher.c.put(`/class-results/${fx.armA}/comments`).send({ items: [{ studentId: fx.kids[0].id, teacher: sug[0].teacher }] })).status).toBe(200);
    expect((await fx.classTeacher.c.put(`/class-results/${fx.armA}/comments`).send({ items: [{ studentId: fx.kids[0].id, principal: 'Nice' }] })).status).toBe(403);
    expect((await fx.principal.c.put(`/class-results/${fx.armA}/comments`).send({ items: [{ studentId: fx.kids[0].id, principal: 'Excellent. Keep it up.' }] })).status).toBe(200);
    const v = await view(fx);
    expect(v.students[0]).toMatchObject({ principalComment: 'Excellent. Keep it up.' });
    expect(v.students[0].ratings[0]).toMatchObject({ value: 5 });
  });

  it('exports a broadsheet that matches the screen', async () => {
    const fx = await resultsSchool({ students: 3 });
    await fillAllSheets(fx, (k) => ({ ca1: 10 + k, ca2: 12, exam: 40 }));
    await compile(fx);
    const data = (await fx.classTeacher.c.get(`/class-results/${fx.armA}/broadsheet`)).body.data;
    expect(data.rows.length).toBe(3);
    expect(data.subjects.sort()).toEqual([...SUBJECTS].sort());
    const xl = await fx.classTeacher.c.get(`/class-results/${fx.armA}/broadsheet?format=xlsx`);
    const file = await client().agent.get(xl.body.data.url).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body);
    const ws = wb.worksheets[0];
    expect(ws.rowCount).toBe(4);
    const header = (ws.getRow(1).values as any[]).slice(1);
    const totalCol = header.indexOf('Total') + 1;
    expect(ws.getRow(2).getCell(totalCol).value).toBe(data.rows[0].total);
    const pdf = await fx.classTeacher.c.get(`/class-results/${fx.armA}/broadsheet?format=pdf`);
    expect(pdf.status).toBe(200);
    // a subject teacher cannot export it
    expect((await fx.teacherA.c.get(`/class-results/${fx.armA}/broadsheet`)).status).toBe(403);
  });

  it('keeps nursery results to ratings and remarks, with no totals or positions', async () => {
    const fx = await resultsSchool({ students: 0 });
    await fx.oc.post('/setup/apply-presets').send({ classLevels: ['nursery_2'] });
    const lv = (await fx.oc.get('/class-levels')).body.data.find((l: any) => l.name === 'Nursery 2');
    const arm = lv.arms[0].id;
    const kid = await addStudent(fx, { first: 'Tiny', arm, guardianPhone: '08034440000' });
    const staff = await makeStaff(fx.school, ['class_teacher']);
    await fx.oc.put('/teaching-assignments').send({ items: [{ classArmId: arm, staffId: String(staff.staff._id), kind: 'class_teacher' }] });
    const { c } = await signIn(staff.phone, fx.host);
    await c.post('/auth/refresh').send({});
    const view = (await c.get(`/class-results/${arm}`)).body.data;
    expect(view.layout).toBe('ratings');
    const areas = view.traits.filter((t: any) => t.category === 'learning_area');
    expect(areas.length).toBeGreaterThan(3);
    await c.put(`/class-results/${arm}/ratings`).send({ items: [{ studentId: kid.id, ratings: [{ traitId: areas[0].id, value: 4, remark: 'Reads simple words' }] }] });
    expect((await c.post(`/class-results/${arm}/compile`).send({})).status).toBe(202);
    await drainJobs();
    const after = (await c.get(`/class-results/${arm}`)).body.data;
    expect(after.status).toBe('compiled');
    expect(after.students[0]).toMatchObject({ total: null, average: null, position: null });
    expect(after.students[0].ratings[0]).toMatchObject({ value: 4, remark: 'Reads simple words' });
    await c.post(`/class-results/${arm}/submit`).send({});
    await fx.principal.c.post(`/class-results/${arm}/approve`).send({});
    await fx.principal.c.post(`/class-results/${arm}/publish`).send({});
    await drainJobs();
    const p = await parentLogin(fx, kid.guardianId);
    const res = (await p.get(`/results/students/${kid.id}`)).body.data[0];
    expect(res.average).toBeNull();
    expect(res.ratings[0].name).toBeTruthy();
    expect((await p.get(`/results/students/${kid.id}/report-card`)).status).toBe(200);
  });

  it('compiles 45 students with 12 subjects within 10 seconds', async () => {
    const names = ['English Language', 'Mathematics', 'Basic Science and Technology', 'Social Studies', 'Civic Education', 'Agricultural Science', 'Home Economics', 'Computer Studies', 'Physical and Health Education', 'Cultural and Creative Arts', 'Verbal Reasoning', 'Quantitative Reasoning'];
    const fx = await resultsSchool({ students: 0, subjects: names });
    // 45 students straight into the database: the point here is the compile, not 45 admissions
    const sid = (await ctxFor(String(fx.school._id), () => AcademicSession.findOne({ status: 'current' }).lean()))._id;
    await ctxFor(String(fx.school._id), async () => {
      for (let i = 0; i < 45; i++) {
        const s = await Student.create({ admissionNumber: `PERF/${i}`, firstName: `P${i}`, lastName: 'Perf', dob: '2016-01-01', gender: 'male' });
        await Enrolment.create({ studentId: s._id, sessionId: sid, classLevelId: fx.levelId, classArmId: fx.armA });
      }
    });
    const students: any[] = await ctxFor(String(fx.school._id), () => Student.find({}).sort({ admissionNumber: 1 }).lean());
    fx.kids = students.map((s) => ({ id: String(s._id), admissionNumber: s.admissionNumber, guardianId: '', phone: '' }));
    const teacher = fx.teacherA;
    const assignItems = names.map((n) => ({ classArmId: fx.armA, subjectId: fx.subjects[n], staffId: teacher.staffId, kind: 'subject_teacher' }));
    await fx.oc.put('/teaching-assignments').send({ items: assignItems });
    await teacher.c.post('/auth/refresh').send({});
    for (const n of names) {
      const cells = fx.kids.flatMap((k, i) => [{ studentId: k.id, component: 'ca1', score: 10 + (i % 10) }, { studentId: k.id, component: 'ca2', score: 12 }, { studentId: k.id, component: 'exam', score: 30 + (i % 25) }]);
      expect((await teacher.c.patch(`/score-sheets/${fx.armA}/${fx.subjects[n]}`).send({ cells })).status).toBe(200);
      expect((await teacher.c.post(`/score-sheets/${fx.armA}/${fx.subjects[n]}/submit`).send({})).status).toBe(200);
    }
    const t0 = Date.now();
    expect((await compile(fx)).status).toBe(202);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(10_000);
    const v = await view(fx);
    expect(v.status).toBe('compiled');
    expect(v.students.length).toBe(45);
    expect(v.students.every((s: any) => s.subjectsCount === 12)).toBe(true);
    void uploadPng; void PASSWORD;
  });
});
