import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ctxFor, drainJobs, platform, resetDb, startTestDb, stopTestDb } from './helpers';
import { addStudent, parentLogin } from './fixtures';
import { completeTerm, openTermNumber, resultsSchool, SUBJECTS, type ResultsFixture } from './resultsFixture';
import { AuditLog, AttendanceRegister, ClassArm, ClassLevel, Enrolment, PromotionDecision, Student, Term } from '../src/models';
import { addDays, todayLagos } from '../src/lib/dates';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(resetDb);

const MTH = SUBJECTS[1];
// pupil 1 strong, pupil 2 weak, pupil 3 middling
const EXAMS = [58, 12, 36, 40];
const scoreFor = (k: number) => ({ ca1: 12 + (k === 0 ? 6 : 0), ca2: 12 + (k === 0 ? 6 : 0), exam: EXAMS[k] ?? 40 });

/** A class that has finished all three terms. Pupil 4 joins in the second term. */
async function finishedYear(opts: { rule?: boolean } = {}) {
  const fx = await resultsSchool({ students: 3 });
  // a second level for them to move up into
  await fx.oc.post('/setup/apply-presets').send({ classLevels: ['primary_4', 'primary_5'] });
  const levels = (await fx.oc.get('/class-levels')).body.data as any[];
  const p5 = levels.find((l) => l.name === 'Primary 5');
  const p4 = levels.find((l) => l.name === 'Primary 4');
  // applying presets again re-adds the full subject list, so trim the level back to the three this test uses
  await fx.oc.put(`/class-levels/${fx.levelId}/subjects`).send({ items: Object.values(fx.subjects).map((id) => ({ subjectId: id, compulsory: true })) });
  expect(String(p4.nextLevelId)).toBe(p5.id);
  if (opts.rule) {
    const r = await fx.principal.c.put(`/promotion/rules/${fx.levelId}`).send({ minAnnualAverage: 50, mustPassSubjectIds: [fx.subjects[MTH]], minSubjectsPassed: 2 });
    expect(r.status).toBe(200);
  }
  await completeTerm(fx, (k) => scoreFor(k));
  await openTermNumber(fx, 2);
  fx.kids.push(await addStudent(fx, { first: 'Latecomer', last: 'Result', guardianPhone: '08032009999' })); // joined in the second term
  await completeTerm(fx, (k) => scoreFor(k));
  await openTermNumber(fx, 3);
  await completeTerm(fx, (k) => scoreFor(k));
  return { fx, p5, p4 };
}

const list = async (fx: ResultsFixture) => (await fx.classTeacher.c.get(`/promotion/lists/${fx.armA}`)).body.data;

describe('M13 annual results and promotion proposals', () => {
  it('builds the annual result from the terms a student has, and proposes outcomes listing the conditions met and not met', async () => {
    const { fx } = await finishedYear({ rule: true });
    const l = await list(fx);
    expect(l.status).toBe('proposed');
    const byName = Object.fromEntries(l.students.map((s: any) => [s.name, s]));
    expect(byName['Pupil1 Result'].proposed.outcome).toBe('promoted');
    expect(byName['Pupil2 Result'].proposed.outcome).toBe('repeat');
    const checks = byName['Pupil2 Result'].proposed.checks;
    expect(checks.find((c: any) => c.condition === 'annual_average')).toMatchObject({ required: 50, passed: false });
    expect(checks.find((c: any) => c.condition === 'must_pass:Mathematics')).toMatchObject({ passed: false, label: 'Must pass Mathematics' });
    // the student who joined in term 2 has an annual average from two terms, and the proposal says so
    expect(byName['Latecomer Result'].note).toMatch(/uses 2 terms/);
    const annual = await fx.classTeacher.c.get('/results/students/' + byName['Latecomer Result'].studentId + '/annual');
    expect(annual.status).toBe(200);
    expect(annual.body.data.termsCounted).toEqual([2, 3]);
    expect(annual.body.data.subjects[0]).toMatchObject({ t1: null });
    // an annual result for the first student shows all three terms
    const a0 = (await fx.classTeacher.c.get('/results/students/' + byName['Pupil1 Result'].studentId + '/annual')).body.data;
    expect(a0.termsCounted).toEqual([1, 2, 3]);
    expect(a0.position).toBe(1);
  });

  it('proposes "to be decided" when a class has no rules, and the teacher must choose before submitting', async () => {
    const { fx } = await finishedYear();
    const l = await list(fx);
    expect(l.students.every((s: any) => s.proposed.outcome === 'undecided' && s.proposed.checks.length === 0)).toBe(true);
    const blocked = await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/submit`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.undecided.length).toBe(4);
    for (const s of l.students) {
      const r = await fx.classTeacher.c.patch(`/promotion/decisions/${s.id}`).send({ outcome: 'promoted', reason: 'Class teacher’s judgement' });
      expect(r.status).toBe(200);
    }
    expect((await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/submit`).send({})).status).toBe(200);
  });

  it('refuses an override without a reason, stores it beside the unchanged proposal, and audits it', async () => {
    const { fx } = await finishedYear({ rule: true });
    const l = await list(fx);
    const weak = l.students.find((s: any) => s.name === 'Pupil2 Result');
    expect((await fx.classTeacher.c.patch(`/promotion/decisions/${weak.id}`).send({ outcome: 'promoted_on_trial' })).status).toBe(422);
    expect((await fx.classTeacher.c.patch(`/promotion/decisions/${weak.id}`).send({ outcome: 'promoted_on_trial', reason: 'ab' })).status).toBe(422);
    const ok = await fx.classTeacher.c.patch(`/promotion/decisions/${weak.id}`).send({ outcome: 'promoted_on_trial', reason: 'Was ill for six weeks in second term.' });
    expect(ok.status).toBe(200);
    const after = (await list(fx)).students.find((s: any) => s.name === 'Pupil2 Result');
    expect(after.proposed.outcome).toBe('repeat'); // unchanged
    expect(after.final).toMatchObject({ outcome: 'promoted_on_trial', reason: 'Was ill for six weeks in second term.' });
    expect(after.outcome).toBe('promoted_on_trial');
    expect((await platform(() => AuditLog.find({ action: 'promotion.override' }).lean())).length).toBe(1);
    // only the school's final class can graduate
    expect((await fx.classTeacher.c.patch(`/promotion/decisions/${weak.id}`).send({ outcome: 'graduated', reason: 'Not final' })).status).toBe(422);
    // another class teacher cannot touch it
    expect((await fx.teacherA.c.patch(`/promotion/decisions/${weak.id}`).send({ outcome: 'repeat', reason: 'Nope nope' })).status).toBe(403);
  });

  it('versions the rules: changing a rule after proposals exist creates version 2 and earlier decisions still point to version 1', async () => {
    const { fx } = await finishedYear({ rule: true });
    const before: any[] = await ctxFor(String(fx.school._id), () => PromotionDecision.find({}).lean());
    expect(before.every((d) => d.ruleVersion === 1)).toBe(true);
    const v2 = await fx.principal.c.put(`/promotion/rules/${fx.levelId}`).send({ minAnnualAverage: 30 });
    expect(v2.body.data.version).toBe(2);
    const versions = (await fx.principal.c.get(`/promotion/rules/${fx.levelId}/versions`)).body.data;
    expect(versions.map((v: any) => [v.version, v.active])).toEqual([[2, true], [1, false]]);
    const still: any[] = await ctxFor(String(fx.school._id), () => PromotionDecision.find({}).lean());
    expect(still.every((d) => d.ruleVersion === 1)).toBe(true); // stored proposals are not altered
    // running the rules again uses the new version, and the old checks are replaced
    expect((await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/propose`).send({})).status).toBe(202);
    await drainJobs();
    expect((await ctxFor(String(fx.school._id), () => PromotionDecision.findOne({}).lean())).ruleVersion).toBe(2);
    // a subject that is not taught at the level cannot be a must-pass subject
    expect((await fx.principal.c.put(`/promotion/rules/${fx.levelId}`).send({ mustPassSubjectIds: [fx.levelId] })).status).toBe(422);
  });

  it('prints the promotion outcome on the third-term report card and shows it to the parent once the principal approves the list', async () => {
    const { fx } = await finishedYear({ rule: true });
    const l = await list(fx);
    expect((await fx.principal.c.post(`/promotion/lists/${fx.armA}/approve`).send({})).status).toBe(409); // not submitted yet
    await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/submit`).send({});
    // the principal can return it with a note
    expect((await fx.principal.c.post(`/promotion/lists/${fx.armA}/return`).send({ note: 'Check Pupil 3' })).status).toBe(200);
    expect((await list(fx)).returnNote).toBe('Check Pupil 3');
    await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/submit`).send({});
    await fx.oc.post('/auth/confirm-password').send({ password: 'Correct-Horse-9' });
    expect((await fx.principal.c.post(`/promotion/lists/${fx.armA}/approve`).send({})).status).toBe(200);
    await drainJobs();
    const p = await parentLogin(fx, fx.kids[0].guardianId);
    const results = (await p.get(`/results/students/${fx.kids[0].id}`)).body.data;
    const third = results.find((r: any) => r.term === 3);
    expect(third.promotionOutcome).toBe('Promoted to the next class');
    expect(l.students.length).toBe(4);
    // an approved list cannot be changed without returning it
    const weak = l.students.find((s: any) => s.name === 'Pupil2 Result');
    expect((await fx.principal.c.patch(`/promotion/decisions/${weak.id}`).send({ outcome: 'promoted', reason: 'Late change' })).status).toBe(409);
  });
});

describe('M13 session rollover', () => {
  async function ready() {
    const out = await finishedYear({ rule: true });
    const { fx } = out;
    // promoted students move up; the weak one repeats; the latecomer is checked by hand
    await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/submit`).send({}).then(async (r) => {
      if (r.status !== 200) {
        const l = await list(fx);
        for (const s of l.students.filter((x: any) => x.outcome === 'undecided')) await fx.classTeacher.c.patch(`/promotion/decisions/${s.id}`).send({ outcome: 'promoted', reason: 'Joined late; judged on two terms' });
        await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/submit`).send({});
      }
    });
    const next = await fx.oc.post('/sessions').send({ name: '2027/2028', terms: [{ number: 1, startDate: addDays(todayLagos(), 330), endDate: addDays(todayLagos(), 420) }, { number: 2, startDate: addDays(todayLagos(), 430), endDate: addDays(todayLagos(), 500) }, { number: 3, startDate: addDays(todayLagos(), 510), endDate: addDays(todayLagos(), 590) }] });
    expect(next.status).toBe(201);
    expect(next.body.data.status).toBe('upcoming');
    return { ...out, toSessionId: next.body.data.id as string };
  }
  const confirm = (fx: ResultsFixture) => fx.principal.c.post('/auth/confirm-password').send({ password: 'Correct-Horse-9' });

  it('is blocked while any list is unapproved, and the preview shows each student’s next class once it is approved', async () => {
    const { fx, toSessionId, p5 } = await ready();
    const blocked = (await fx.principal.c.get(`/promotion/rollover/preview?toSessionId=${toSessionId}`)).body.data;
    expect(blocked.canRun).toBe(false);
    expect(blocked.blockers.map((b: any) => b.kind)).toContain('list_not_approved');
    await confirm(fx);
    expect((await fx.principal.c.post(`/promotion/lists/${fx.armA}/approve`).send({})).status).toBe(200);
    const pv = (await fx.principal.c.get(`/promotion/rollover/preview?toSessionId=${toSessionId}`)).body.data;
    expect(pv.canRun).toBe(true);
    const byName = Object.fromEntries(pv.students.map((s: any) => [s.name, s]));
    expect(byName['Pupil1 Result']).toMatchObject({ currentClass: 'Primary 4 A', nextClass: 'Primary 5 A', outcome: 'promoted' });
    expect(byName['Pupil2 Result']).toMatchObject({ nextClass: 'Primary 4 A', outcome: 'repeat' });
    expect(pv.counts).toMatchObject({ repeat: 1 });
    void p5;
    // an unplaceable arm choice is flagged
    const manual = (await fx.principal.c.get(`/promotion/rollover/preview?toSessionId=${toSessionId}&armMode=manual`)).body.data;
    expect(manual.canRun).toBe(false);
  });

  it('stops and asks for arms when the next level has none', async () => {
    const { fx, toSessionId, p5 } = await ready();
    await confirm(fx);
    await fx.principal.c.post(`/promotion/lists/${fx.armA}/approve`).send({});
    // remove Primary 5's only arm
    const arm = p5.arms[0].id;
    await ctxFor(String(fx.school._id), () => ClassArm.deleteOne({ _id: arm }));
    const pv = (await fx.principal.c.get(`/promotion/rollover/preview?toSessionId=${toSessionId}`)).body.data;
    expect(pv.canRun).toBe(false);
    expect(pv.blockers.some((b: any) => b.kind === 'no_arms' && /Primary 5 has no arms/.test(b.message))).toBe(true);
    const run = await fx.principal.c.post('/promotion/rollover').set('Idempotency-Key', 'rollover-blocked-1').send({ toSessionId });
    expect(run.status).toBe(409);
  });

  it('moves promoted students up, keeps repeaters, closes the old session, opens the new one, copies assignments as a draft, and running it twice creates no duplicates', async () => {
    const { fx, toSessionId, p5, p4 } = await ready();
    await confirm(fx);
    await fx.principal.c.post(`/promotion/lists/${fx.armA}/approve`).send({});
    const run = await fx.principal.c.post('/promotion/rollover').set('Idempotency-Key', 'rollover-ok-1234').send({ toSessionId });
    expect(run.status).toBe(202);
    await drainJobs();
    const again = await fx.principal.c.post('/promotion/rollover').set('Idempotency-Key', 'rollover-ok-5678').send({ toSessionId });
    expect(again.status).toBe(409); // already rolled over
    await drainJobs();

    const sessions = (await fx.oc.get('/sessions')).body.data as any[];
    expect(sessions.find((s) => s.name === '2026/2027').status).toBe('closed');
    expect(sessions.find((s) => s.name === '2027/2028')).toMatchObject({ status: 'current' });
    expect(sessions.find((s) => s.name === '2027/2028').terms.map((t: any) => t.status)).toEqual(['current', 'upcoming', 'upcoming']);

    const s = ctxFor(String(fx.school._id), async () => {
      const students: any[] = await Student.find({}).lean();
      const enr: any[] = await Enrolment.find({}).lean();
      return { students, enr };
    });
    const { students, enr } = await s;
    const level = (name: string) => students.filter((st) => st.firstName === name).map((st) => enr.filter((e) => String(e.studentId) === String(st._id) && e.sessionId && true));
    void level;
    const newSession = sessions.find((x) => x.name === '2027/2028').id;
    const nowIn = (first: string) => {
      const stu = students.find((st) => st.firstName === first)!;
      const e = enr.find((x) => String(x.studentId) === String(stu._id) && String(x.sessionId) === newSession);
      return e ? String(e.classLevelId) : null;
    };
    expect(nowIn('Pupil1')).toBe(p5.id);
    expect(nowIn('Pupil2')).toBe(p4.id);
    // enrolment history holds both sessions for every student, and there are no duplicates
    expect(enr.length).toBe(8);
    const history = (await fx.oc.get(`/students/${fx.kids[0].id}/enrolments`)).body.data;
    expect(history.map((h: any) => h.session).sort()).toEqual(['2026/2027', '2027/2028']);
    expect(history.find((h: any) => h.session === '2026/2027').outcome).toBe('promoted');
    // assignments are copied forward as drafts
    const draft = (await fx.oc.get(`/teaching-assignments?sessionId=${newSession}`)).body.data as any[];
    expect(draft.length).toBeGreaterThan(0);
    expect(draft.every((d) => d.draft)).toBe(true);
    expect((await fx.oc.post('/teaching-assignments/confirm-drafts').send({})).body.data.confirmed).toBe(draft.length);
  });

  it('turns graduates into alumni who are off class lists, with their login ended', async () => {
    const { fx, toSessionId } = await ready();
    // make Primary 4 the school's final level for this test
    await fx.oc.patch(`/class-levels/${fx.levelId}`).send({ isFinal: true, nextLevelId: null });
    await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/propose`).send({}).catch(() => undefined);
    await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/return`).send({}).catch(() => undefined);
    const l0 = await list(fx);
    if (l0.status === 'reviewed') await fx.principal.c.post(`/promotion/lists/${fx.armA}/return`).send({ note: 'Final class' });
    await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/propose`).send({});
    await drainJobs();
    const l = await list(fx);
    expect(l.isFinalClass).toBe(true);
    const passed = l.students.filter((s: any) => s.proposed.outcome === 'graduated');
    expect(passed.length).toBeGreaterThan(0); // those who meet the rules graduate
    for (const s of l.students.filter((x: any) => x.outcome === 'repeat')) await fx.classTeacher.c.patch(`/promotion/decisions/${s.id}`).send({ outcome: 'repeat', reason: 'Did not meet the rules' });
    for (const s of l.students.filter((x: any) => x.outcome === 'undecided')) await fx.classTeacher.c.patch(`/promotion/decisions/${s.id}`).send({ outcome: 'graduated', reason: 'Completed the course' });
    expect((await fx.classTeacher.c.post(`/promotion/lists/${fx.armA}/submit`).send({})).status).toBe(200);
    await confirm(fx);
    expect((await fx.principal.c.post(`/promotion/lists/${fx.armA}/approve`).send({})).status).toBe(200);
    expect((await fx.principal.c.post('/promotion/rollover').set('Idempotency-Key', 'rollover-grad-1234').send({ toSessionId })).status).toBe(202);
    await drainJobs();
    const alumni: any[] = await ctxFor(String(fx.school._id), () => Student.find({ alumni: true }).lean());
    expect(alumni.length).toBe(passed.length + l.students.filter((x: any) => x.outcome === 'undecided').length);
    expect(alumni.every((a) => a.status === 'graduated')).toBe(true);
    const list2 = (await fx.oc.get(`/students?classArmId=${fx.armA}&status=active`)).body.data;
    expect(list2.every((s: any) => !alumni.some((a) => String(a._id) === s.id))).toBe(true);
    void ClassLevel;
  });

  it('can be undone only while nothing has been recorded in the new session', async () => {
    const { fx, toSessionId } = await ready();
    await confirm(fx);
    await fx.principal.c.post(`/promotion/lists/${fx.armA}/approve`).send({});
    await fx.principal.c.post('/promotion/rollover').set('Idempotency-Key', 'rollover-undo-12').send({ toSessionId });
    await drainJobs();
    // only the owner can undo
    expect((await fx.principal.c.post('/promotion/rollover/undo').send({})).status).toBe(403);
    await fx.oc.post('/auth/confirm-password').send({ password: 'Correct-Horse-9' });
    const undo = await fx.oc.post('/promotion/rollover/undo').send({});
    expect(undo.status).toBe(200);
    const sessions = (await fx.oc.get('/sessions')).body.data as any[];
    expect(sessions.find((s) => s.name === '2027/2028').status).toBe('upcoming');
    expect(sessions.find((s) => s.name === '2026/2027').status).toBe('current');
    expect(await ctxFor(String(fx.school._id), () => Enrolment.countDocuments({}))).toBe(4);
    // run it again, then record attendance in the new session: undo is refused
    await fx.principal.c.post('/promotion/rollover').set('Idempotency-Key', 'rollover-undo-34').send({ toSessionId });
    await drainJobs();
    await ctxFor(String(fx.school._id), async () => {
      const terms = (await Term.find({ status: 'current' }).lean()) as any[];
      await AttendanceRegister.create({ termId: terms[0]._id, classArmId: fx.armA, date: addDays(todayLagos(), 340), part: 'day', entries: [] });
    });
    await fx.oc.post('/auth/confirm-password').send({ password: 'Correct-Horse-9' });
    const refused = await fx.oc.post('/promotion/rollover/undo').send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.attendance).toBe(true);
  });
});
