import { hostOf, makeStaff, signIn, type Client } from './helpers';
import { addStudent, buildSchool, type Fixture } from './fixtures';

export interface ResultsFixture extends Fixture {
  subjects: Record<string, string>; // name -> id
  kids: Array<Awaited<ReturnType<typeof addStudent>>>;
  teacherA: { c: Client; staffId: string; phone: string };
  teacherB: { c: Client; staffId: string; phone: string };
  classTeacher: { c: Client; staffId: string; phone: string };
  principal: { c: Client; phone: string; userId: string };
}

export const SUBJECTS = ['English Language', 'Mathematics', 'Basic Science and Technology'];

/** A class of students with three compulsory subjects, two subject teachers, a class teacher and a principal. */
export async function resultsSchool(opts: { students?: number; subjects?: string[]; schoolStatus?: string } = {}): Promise<ResultsFixture> {
  const fx = (await buildSchool({ status: opts.schoolStatus })) as ResultsFixture;
  const all = (await fx.oc.get('/subjects')).body.data as any[];
  const names = opts.subjects ?? SUBJECTS;
  const picked = names.map((n) => all.find((s) => s.name === n)!);
  fx.subjects = Object.fromEntries(picked.map((s) => [s.name, String(s._id)]));
  await fx.oc.put(`/class-levels/${fx.levelId}/subjects`).send({ items: picked.map((s) => ({ subjectId: String(s._id), compulsory: true })) });

  const mk = async (roles: string[]) => {
    const st = await makeStaff(fx.school, roles);
    const { c } = await signIn(st.phone, hostOf(fx.school));
    return { c, staffId: String(st.staff._id), phone: st.phone, userId: String(st.user._id) };
  };
  fx.teacherA = await mk(['subject_teacher']);
  fx.teacherB = await mk(['subject_teacher']);
  fx.classTeacher = await mk(['class_teacher', 'subject_teacher']);
  fx.principal = await mk(['principal']);

  const items: any[] = [{ classArmId: fx.armA, staffId: fx.classTeacher.staffId, kind: 'class_teacher' }];
  names.forEach((n, i) => items.push({ classArmId: fx.armA, subjectId: fx.subjects[n], staffId: i === 2 ? fx.teacherB.staffId : i === 1 && names.length > 3 ? fx.classTeacher.staffId : fx.teacherA.staffId, kind: 'subject_teacher' }));
  const res = await fx.oc.put('/teaching-assignments').send({ items });
  if (res.status !== 200) throw new Error(`assignments failed ${res.status} ${JSON.stringify(res.body)}`);
  // assignments changed the teachers' roles, so their sessions need a refresh
  for (const t of [fx.teacherA, fx.teacherB, fx.classTeacher]) await t.c.post('/auth/refresh').send({});

  fx.kids = [];
  for (let i = 0; i < (opts.students ?? 4); i++) fx.kids.push(await addStudent(fx, { first: `Pupil${i + 1}`, last: 'Result', guardianPhone: `0803200${String(1000 + i)}` }));
  return fx;
}

export type Marks = Record<string, { ca1?: number | 'ABS'; ca2?: number | 'ABS'; exam?: number | 'ABS' } | 'EXEMPT'>;

/** Enter scores for a subject. `marks` is keyed by admission-number index in fx.kids. */
export async function enterScores(fx: ResultsFixture, who: { c: Client }, subject: string, marks: Marks) {
  const cells: any[] = [];
  for (const [idx, m] of Object.entries(marks)) {
    const studentId = fx.kids[Number(idx)].id;
    if (m === 'EXEMPT') cells.push({ studentId, exempt: true });
    else for (const [component, v] of Object.entries(m)) cells.push(v === 'ABS' ? { studentId, component, absent: true } : { studentId, component, score: v });
  }
  return who.c.patch(`/score-sheets/${fx.armA}/${fx.subjects[subject]}`).send({ cells });
}

export const submitSheet = (fx: ResultsFixture, who: { c: Client }, subject: string) => who.c.post(`/score-sheets/${fx.armA}/${fx.subjects[subject]}/submit`).send({});

/** Give every student the same scores in every subject, submit every sheet. */
export async function fillAllSheets(fx: ResultsFixture, scoreFor: (kid: number, subject: string) => { ca1: number; ca2: number; exam: number }) {
  const owner: Record<string, { c: Client }> = { [SUBJECTS[0]]: fx.teacherA, [SUBJECTS[1]]: fx.teacherA, [SUBJECTS[2]]: fx.teacherB };
  for (const subject of Object.keys(fx.subjects)) {
    const who = owner[subject] ?? fx.teacherA;
    const marks: Marks = {};
    fx.kids.forEach((_, i) => (marks[String(i)] = scoreFor(i, subject)));
    const e = await enterScores(fx, who, subject, marks);
    if (e.status !== 200) throw new Error(`enter failed ${e.status} ${JSON.stringify(e.body)}`);
    const s = await submitSheet(fx, who, subject);
    if (s.status !== 200) throw new Error(`submit failed ${s.status} ${JSON.stringify(s.body)}`);
  }
}

import { drainJobs } from './helpers';

export const compileClass = async (fx: ResultsFixture) => {
  const res = await fx.classTeacher.c.post(`/class-results/${fx.armA}/compile`).send({});
  if (res.status === 202) await drainJobs();
  return res;
};

/** Fill every sheet, compile, submit, approve and publish the current term. */
export async function completeTerm(fx: ResultsFixture, scoreFor: (kid: number, subject: string) => { ca1: number; ca2: number; exam: number }) {
  await fillAllSheets(fx, scoreFor);
  const c = await compileClass(fx);
  if (c.status !== 202) throw new Error(`compile failed ${c.status} ${JSON.stringify(c.body)}`);
  const s = await fx.classTeacher.c.post(`/class-results/${fx.armA}/submit`).send({});
  if (s.status !== 200) throw new Error(`submit failed ${s.status} ${JSON.stringify(s.body)}`);
  const a = await fx.principal.c.post(`/class-results/${fx.armA}/approve`).send({});
  if (a.status !== 200) throw new Error(`approve failed ${a.status} ${JSON.stringify(a.body)}`);
  const p = await fx.principal.c.post(`/class-results/${fx.armA}/publish`).send({});
  if (p.status !== 202) throw new Error(`publish failed ${p.status} ${JSON.stringify(p.body)}`);
  await drainJobs();
}

export async function openTermNumber(fx: ResultsFixture, n: number) {
  const terms = (await fx.oc.get('/terms')).body.data as any[];
  const t = terms.find((x) => x.number === n);
  const res = await fx.principal.c.post(`/terms/${t.id}/open`).send({});
  if (res.status !== 200) throw new Error(`open term failed ${res.status} ${JSON.stringify(res.body)}`);
  return t.id as string;
}
