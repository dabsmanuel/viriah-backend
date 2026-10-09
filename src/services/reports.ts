import { getCtx } from '../core/context';
import { can, me } from '../core/http';
import { attendancePercent } from '../calc/results';
import { AttendanceRegister, Application, ClassArm, ClassLevel, Enrolment, Invoice, NonSchoolDay, Payment, Score, Staff, Student, Subject, Term, TermResult } from '../models';
import { armStudents } from './academics';
import { fullName } from './common';
import { currentSession, hasFullReach, myTeaching, resolveTerm } from './reach';
import { classNames } from './students';

/** Standard reports (RPT-01, RPT-02). The dashboards use the same functions, so leadership figures equal the reports for the same period. */

export async function enrolmentReport() {
  const session = await currentSession();
  if (!session) return { session: null, rows: [], total: { male: 0, female: 0, total: 0 } };
  const enrol: any[] = await Enrolment.find({ sessionId: session._id, to: { $exists: false } }).lean();
  const students = new Map<string, any>((await Student.find({ _id: { $in: enrol.map((e) => e.studentId) }, status: 'active' }).select('gender').lean()).map((s: any) => [String(s._id), s]));
  const levels: any[] = await ClassLevel.find({}).sort({ order: 1 }).lean();
  const arms: any[] = await ClassArm.find({}).lean();
  const names = await classNames(arms.map((a) => String(a._id)));
  const byArm = new Map<string, { male: number; female: number }>();
  for (const e of enrol) {
    const s = students.get(String(e.studentId));
    if (!s) continue;
    const k = String(e.classArmId);
    const row = byArm.get(k) ?? { male: 0, female: 0 };
    if (s.gender === 'female') row.female += 1;
    else row.male += 1;
    byArm.set(k, row);
  }
  const rows = levels.flatMap((l) =>
    arms
      .filter((a) => String(a.classLevelId) === String(l._id) && byArm.has(String(a._id)))
      .map((a) => {
        const r = byArm.get(String(a._id))!;
        return { classArmId: String(a._id), class: names.get(String(a._id))?.name, male: r.male, female: r.female, total: r.male + r.female };
      })
  );
  const total = rows.reduce((a, r) => ({ male: a.male + r.male, female: a.female + r.female, total: a.total + r.total }), { male: 0, female: 0, total: 0 });
  return { session: session.name, rows, total };
}

export async function admissionsReport() {
  const apps: any[] = await Application.find({ status: { $ne: 'draft' } }).select('status classLevelId').lean();
  const levels = new Map<string, any>((await ClassLevel.find({}).lean()).map((l: any) => [String(l._id), l]));
  const byStatus: Record<string, number> = {};
  const byClass = new Map<string, Record<string, number>>();
  for (const a of apps) {
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const cn = levels.get(String(a.classLevelId))?.name ?? 'Not chosen';
    const row = byClass.get(cn) ?? {};
    row[a.status] = (row[a.status] ?? 0) + 1;
    byClass.set(cn, row);
  }
  return { total: apps.length, byStatus, byClass: [...byClass.entries()].map(([klass, statuses]) => ({ class: klass, ...statuses, total: Object.values(statuses).reduce((x, y) => x + y, 0) })) };
}

/** Attendance rates by class and period. A class teacher sees their own class. */
export async function attendanceReport(from?: string, to?: string) {
  const session = await currentSession();
  const t = await myTeaching();
  const full = hasFullReach() || me().roles.includes('principal');
  const filter: any = {};
  if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const holidays = new Set((await NonSchoolDay.find({}).select('date').lean()).map((h: any) => h.date));
  const regs: any[] = await AttendanceRegister.find(filter).lean();
  const byArm = new Map<string, { opened: number; present: number; absent: number; days: Set<string> }>();
  for (const r of regs) {
    if (holidays.has(r.date)) continue;
    const arm = String(r.classArmId);
    if (!full && !t.classTeacherArms.has(arm)) continue;
    const row = byArm.get(arm) ?? { opened: 0, present: 0, absent: 0, days: new Set<string>() };
    row.days.add(r.date);
    for (const e of r.entries) {
      row.opened += 1;
      if (e.status === 'present' || e.status === 'late') row.present += 1;
      else row.absent += 1;
    }
    byArm.set(arm, row);
  }
  const names = await classNames([...byArm.keys()]);
  const rows = [...byArm.entries()].map(([arm, r]) => ({ classArmId: arm, class: names.get(arm)?.name, daysOpened: r.days.size, marks: r.opened, present: r.present, absent: r.absent, percent: attendancePercent(r.present, r.opened) })).sort((a, b) => String(a.class).localeCompare(String(b.class)));
  const all = rows.reduce((a, r) => ({ present: a.present + r.present, marks: a.marks + r.marks }), { present: 0, marks: 0 });
  return { session: session?.name, from, to, rows, percent: attendancePercent(all.present, all.marks) };
}

/** Today's attendance across the school, from the registers taken today. */
export async function attendanceToday(date: string) {
  const regs: any[] = await AttendanceRegister.find({ date }).lean();
  let marks = 0;
  let present = 0;
  for (const r of regs) for (const e of r.entries) {
    marks += 1;
    if (e.status === 'present' || e.status === 'late') present += 1;
  }
  return { registersTaken: regs.length, marks, present, absent: marks - present, percent: attendancePercent(present, marks) };
}

/** Result summaries by class and subject for a term. */
export async function academicReport(armId: string | undefined, termId?: string) {
  const term: any = await resolveTerm(termId);
  const c = me();
  const t = await myTeaching();
  const full = hasFullReach() || c.roles.includes('principal');
  const armIds = armId ? [armId] : (await ClassArm.find({ active: true }).select('_id').lean()).map((a: any) => String(a._id));
  const allowed = armIds.filter((a) => full || t.classTeacherArms.has(a) || t.subjectsByArm.has(a));
  const names = await classNames(allowed);
  const out: any[] = [];
  for (const a of allowed) {
    const students = await armStudents(a, term.sessionId);
    if (!students.length) continue;
    const scores: any[] = await Score.find({ termId: term._id, classArmId: a, studentId: { $in: students.map((s) => s._id) }, total: { $ne: null } }).lean();
    const subs = new Map<string, any>((await Subject.find({ _id: { $in: [...new Set(scores.map((s) => String(s.subjectId)))] } }).lean()).map((s: any) => [String(s._id), s]));
    const subjectRows = [...new Set(scores.map((s) => String(s.subjectId)))]
      .filter((sid) => full || t.classTeacherArms.has(a) || t.subjectsByArm.get(a)?.has(sid))
      .map((sid) => {
        const list = scores.filter((s) => String(s.subjectId) === sid).map((s) => s.total as number);
        const passMark = 40;
        return { subjectId: sid, subject: subs.get(sid)?.name, students: list.length, average: list.reduce((x, y) => x + y, 0) / list.length, highest: Math.max(...list), lowest: Math.min(...list), passed: list.filter((x) => x >= passMark).length };
      })
      .sort((x, y) => String(x.subject).localeCompare(String(y.subject)));
    const trs: any[] = await TermResult.find({ termId: term._id, classArmId: a, average: { $ne: null } }).lean();
    out.push({ classArmId: a, class: names.get(a)?.name, students: students.length, withResults: trs.length, classAverage: trs.length ? trs.reduce((x, r) => x + r.average, 0) / trs.length : null, subjects: subjectRows });
  }
  return { termId: String(term._id), term: term.number, classes: out };
}

/** Expected, collected and outstanding by term and class. */
export async function financeReport(termId?: string) {
  const term: any = await resolveTerm(termId);
  const invs: any[] = await Invoice.find({ termId: term._id, status: { $in: ['issued', 'part_paid', 'paid'] } }).select('studentId totalKobo paidKobo balanceKobo').lean();
  const session = await currentSession();
  const enrol: any[] = session ? await Enrolment.find({ sessionId: term.sessionId, studentId: { $in: invs.map((i) => i.studentId).filter(Boolean) } }).lean() : [];
  const armOf = new Map<string, string>(enrol.map((e) => [String(e.studentId), String(e.classArmId)]));
  const names = await classNames([...new Set(enrol.map((e) => String(e.classArmId)))]);
  const byClass = new Map<string, { expected: number; collected: number; outstanding: number; invoices: number }>();
  for (const i of invs) {
    const k = armOf.get(String(i.studentId)) ?? 'none';
    const row = byClass.get(k) ?? { expected: 0, collected: 0, outstanding: 0, invoices: 0 };
    row.expected += i.totalKobo;
    row.collected += i.paidKobo;
    row.outstanding += i.balanceKobo;
    row.invoices += 1;
    byClass.set(k, row);
  }
  const rows = [...byClass.entries()].map(([k, r]) => ({ classArmId: k === 'none' ? undefined : k, class: k === 'none' ? 'No class' : names.get(k)?.name, expectedKobo: r.expected, collectedKobo: r.collected, outstandingKobo: r.outstanding, invoices: r.invoices })).sort((a, b) => String(a.class).localeCompare(String(b.class)));
  const totals = rows.reduce((a, r) => ({ expectedKobo: a.expectedKobo + r.expectedKobo, collectedKobo: a.collectedKobo + r.collectedKobo, outstandingKobo: a.outstandingKobo + r.outstandingKobo }), { expectedKobo: 0, collectedKobo: 0, outstandingKobo: 0 });
  const flagged = await Payment.countDocuments({ flagged: true, status: 'successful' });
  return { termId: String(term._id), term: term.number, rows, totals, flaggedPayments: flagged };
}

export { getCtx, can, Staff, fullName };
