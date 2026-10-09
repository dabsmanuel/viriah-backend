import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { forbidden, notFound, stateConflict, termClosed, validation } from '../core/errors';
import { can, me } from '../core/http';
import { attendancePercent } from '../calc/results';
import { diffDays, todayLagos } from '../lib/dates';
import { AttendanceRegister, ClassArm, ClassLevel, Enrolment, Guardian, NonSchoolDay, Staff, Student, StudentGuardian, TeachingAssignment, Term } from '../models';
import { assertTermOpen } from './academics';
import { fullName, loadSchool, need } from './common';
import { notify } from './notify';
import { assertCanSeeStudent, assertClassTeacherOf, currentSession, hasFullReach, myTeaching, resolveTerm } from './reach';
import { classNames } from './students';
import { photoUrl } from './common';

/** The daily class register (ATT-01 to ATT-05, flow F12). */

export type Status = 'present' | 'absent' | 'late' | 'excused';
const EDIT_WINDOW_DAYS = 7;

export async function rosterOf(armId: string, sessionId?: unknown) {
  const sid = sessionId ?? (await currentSession())?._id;
  if (!sid) return [];
  const e: any[] = await Enrolment.find({ sessionId: sid, classArmId: armId, to: { $exists: false } }).select('studentId').lean();
  const students: any[] = await Student.find({ _id: { $in: e.map((x) => x.studentId) }, status: 'active' }).select('firstName lastName admissionNumber gender photo').sort({ lastName: 1, firstName: 1 }).lean();
  return students;
}

/** Which part of the day this register covers, from the school's setting. */
async function partFor(input?: string): Promise<'day' | 'am' | 'pm'> {
  const school: any = await loadSchool();
  if (school.settings?.registerSessions === 'am_pm') {
    if (input !== 'am' && input !== 'pm') throw validation('This school takes a morning and an afternoon register. Choose which one.', { part: 'Choose am or pm.' });
    return input;
  }
  return 'day';
}

async function termForDate(date: string) {
  const current: any = await Term.findOne({ status: 'current' }).lean();
  if (!current && (await Term.exists({ status: 'closed' }))) throw termClosed();
  if (!current) throw validation('There is no current term. Open a term first.', { date: 'No current term.' });
  if ((current.startDate && date < current.startDate) || (current.endDate && date > current.endDate)) throw validation('That date is outside the current term.', { date: 'Outside the term.' });
  return current;
}

export async function getRegister(armId: string, date: string, partInput?: string) {
  await assertArmAccess(armId);
  const part = await partFor(partInput);
  const reg: any = await AttendanceRegister.findOne({ classArmId: armId, date, part }).lean();
  const roster = await rosterOf(armId);
  const entries = new Map<string, Status>((reg?.entries ?? []).map((e: any) => [String(e.studentId), e.status]));
  const holiday = await NonSchoolDay.findOne({ date }).lean();
  return {
    id: reg ? String(reg._id) : undefined,
    classArmId: armId,
    date,
    part,
    taken: !!reg,
    holiday: holiday ? { reason: (holiday as any).reason } : null,
    locked: reg ? isLocked(reg) : false,
    // All students default to present.
    entries: roster.map((s) => ({ studentId: String(s._id), name: fullName(s), admissionNumber: s.admissionNumber, photoUrl: photoUrl(s.photo), status: entries.get(String(s._id)) ?? ('present' as Status) }))
  };
}

const isLocked = (reg: any) => diffDays(todayLagos(), reg.date) > EDIT_WINDOW_DAYS && !(reg.unlockedUntil && new Date(reg.unlockedUntil) > new Date());

async function assertArmAccess(armId: string) {
  await need(ClassArm.findById(armId).lean(), 'Class');
  if (hasFullReach() || can('attendance.unlock')) return;
  const t = await myTeaching();
  if (!t.arms.has(armId)) throw notFound('Class');
}

/** Only the class teacher of that arm can save its register. */
export async function saveRegister(input: { classArmId: string; date: string; part?: string; entries: Array<{ studentId: string; status: Status }> }) {
  const c = me();
  await assertClassTeacherOf(input.classArmId, false);
  if (input.date > todayLagos()) throw validation('You cannot take a register for a future date.', { date: 'In the future.' });
  const term = await termForDate(input.date);
  await assertTermOpen(term._id);
  if (await NonSchoolDay.exists({ date: input.date })) throw stateConflict('That day is marked as a holiday. Remove the holiday first if school was open.');
  const part = await partFor(input.part);
  const roster = await rosterOf(input.classArmId);
  const rosterIds = new Set(roster.map((s) => String(s._id)));
  for (const e of input.entries) if (!rosterIds.has(e.studentId)) throw validation('A student on the list is not in this class.', { entries: 'Not in this class.' });

  const existing: any = await AttendanceRegister.findOne({ classArmId: input.classArmId, date: input.date, part });
  // The class teacher can edit within 7 days. After that the principal must unlock it.
  if (existing && isLocked(existing)) throw stateConflict('This register is locked because it is more than 7 days old. Ask the principal to unlock it.');

  const chosen = new Map(input.entries.map((e) => [e.studentId, e.status]));
  const entries = roster.map((s) => ({ studentId: s._id, status: (chosen.get(String(s._id)) ?? 'present') as Status }));
  const before = new Map<string, Status>((existing?.entries ?? []).map((e: any) => [String(e.studentId), e.status]));

  let reg: any;
  if (existing) {
    existing.entries = entries;
    existing.takenBy = c.userId;
    await existing.save();
    reg = existing;
    await audit({ action: 'attendance.register.edit', entityType: 'attendanceRegister', entityId: existing._id, after: { date: input.date, absent: entries.filter((e) => e.status === 'absent').length } });
  } else {
    reg = await AttendanceRegister.create({ termId: term._id, classArmId: input.classArmId, date: input.date, part, takenBy: c.userId, entries });
  }

  // Optional SMS to the parent when a child is marked absent. Only for newly absent children, so an edit does not repeat it.
  const school: any = await loadSchool();
  const newlyAbsent = entries.filter((e) => e.status === 'absent' && before.get(String(e.studentId)) !== 'absent').map((e) => e.studentId);
  if (newlyAbsent.length) await alertAbsences(newlyAbsent, !!school.settings?.absenceSms);
  return { id: String(reg._id), taken: true, absent: entries.filter((e) => e.status === 'absent').length, alerted: newlyAbsent.length };
}

async function alertAbsences(studentIds: any[], sms: boolean) {
  const students: any[] = await Student.find({ _id: { $in: studentIds } }).select('firstName lastName').lean();
  for (const s of students) {
    const link: any = await StudentGuardian.findOne({ studentId: s._id, access: { $ne: 'none' } }).sort({ isPrimary: -1 }).lean();
    const g: any = link ? await Guardian.findById(link.guardianId).lean() : null;
    if (!g) continue;
    // With alerts off, nothing is queued. With alerts on, the main guardian gets an SMS (and the in-app notice).
    await notify({ event: 'child_absent', to: [{ userId: g.userId ? String(g.userId) : undefined, phone: g.phone, email: g.email, name: fullName(g), kind: 'parent' }], vars: { child: fullName(s) }, force: sms ? { sms: true } : undefined });
  }
}

export async function unlockRegister(id: string) {
  const c = me();
  const reg: any = await need(AttendanceRegister.findById(id), 'Register');
  reg.unlockedUntil = new Date(Date.now() + 24 * 3600_000);
  await reg.save();
  await audit({ action: 'attendance.register.unlock', entityType: 'attendanceRegister', entityId: id, after: { by: c.userId, until: reg.unlockedUntil } });
  return reg;
}

// ------------------------------------------------------------------ totals

/** Days with a register for the arm in the term, leaving out holidays. Each student counts the registers that included them. */
export async function termTotals(termId: string, studentIds?: string[]) {
  const holidays = new Set((await NonSchoolDay.find({ termId }).select('date').lean()).map((h: any) => h.date));
  const regs: any[] = await AttendanceRegister.find({ termId }).lean();
  const out = new Map<string, { opened: number; present: number; absent: number; late: number; excused: number }>();
  const want = studentIds ? new Set(studentIds) : null;
  for (const r of regs) {
    if (holidays.has(r.date)) continue;
    for (const e of r.entries) {
      const id = String(e.studentId);
      if (want && !want.has(id)) continue;
      const t = out.get(id) ?? { opened: 0, present: 0, absent: 0, late: 0, excused: 0 };
      t.opened += 1;
      if (e.status === 'present' || e.status === 'late') t.present += 1;
      else t.absent += 1;
      if (e.status === 'late') t.late += 1;
      if (e.status === 'excused') t.excused += 1;
      out.set(id, t);
    }
  }
  return out;
}

export async function studentTermTotals(studentId: string, termId: string) {
  const t = (await termTotals(termId, [studentId])).get(studentId) ?? { opened: 0, present: 0, absent: 0, late: 0, excused: 0 };
  return { ...t, percent: attendancePercent(t.present, t.opened) };
}

export async function armSummary(armId: string, termId?: string) {
  await assertArmAccess(armId);
  const term = await resolveTerm(termId);
  const roster = await rosterOf(armId, term.sessionId);
  const totals = await termTotals(String(term._id), roster.map((s) => String(s._id)));
  return {
    termId: String(term._id),
    classArmId: armId,
    students: roster.map((s) => {
      const t = totals.get(String(s._id)) ?? { opened: 0, present: 0, absent: 0, late: 0, excused: 0 };
      return { studentId: String(s._id), name: fullName(s), admissionNumber: s.admissionNumber, ...t, percent: attendancePercent(t.present, t.opened) };
    })
  };
}

/** One student's term, day by day. Staff by reach, a parent for their own child, a student for themself. */
export async function studentDays(studentId: string, termId?: string) {
  await assertCanSeeStudent(studentId);
  const term = await resolveTerm(termId);
  const holidays = new Set((await NonSchoolDay.find({ termId: term._id }).select('date').lean()).map((h: any) => h.date));
  const regs: any[] = await AttendanceRegister.find({ termId: term._id, 'entries.studentId': studentId }).sort({ date: 1 }).lean();
  const days = regs.filter((r) => !holidays.has(r.date)).map((r) => ({ date: r.date, part: r.part, status: r.entries.find((e: any) => String(e.studentId) === studentId)?.status }));
  const totals = await studentTermTotals(studentId, String(term._id));
  return { termId: String(term._id), days, totals };
}

/** Class arms with no register for a date. It does not count as a school day until a register exists or the admin marks a holiday. */
export async function missingRegisters(date: string) {
  if (await NonSchoolDay.exists({ date })) return { date, holiday: true, arms: [] };
  const session = await currentSession();
  if (!session) return { date, holiday: false, arms: [] };
  const arms: any[] = await ClassArm.find({ active: true }).lean();
  const done = new Set((await AttendanceRegister.find({ date }).select('classArmId').lean()).map((r: any) => String(r.classArmId)));
  const enrolled = await Enrolment.aggregate([{ $match: { sessionId: session._id, to: { $exists: false } } }, { $group: { _id: '$classArmId', n: { $sum: 1 } } }]);
  const counts = new Map<string, number>(enrolled.map((e: any) => [String(e._id), e.n]));
  const missing = arms.filter((a) => (counts.get(String(a._id)) ?? 0) > 0 && !done.has(String(a._id)));
  const names = await classNames(missing.map((a) => String(a._id)));
  const teachers: any[] = await TeachingAssignment.find({ sessionId: session._id, kind: 'class_teacher', classArmId: { $in: missing.map((a) => a._id) } }).lean();
  const staff = new Map<string, any>((await Staff.find({ _id: { $in: teachers.map((t) => t.staffId) } }).select('firstName lastName').lean()).map((s: any) => [String(s._id), s]));
  return { date, holiday: false, arms: missing.map((a) => ({ classArmId: String(a._id), class: names.get(String(a._id))?.name, classTeacher: fullName(staff.get(String(teachers.find((t) => String(t.classArmId) === String(a._id))?.staffId))) || null })) };
}

// ------------------------------------------------------------------ non-school days (holidays)

export async function addNonSchoolDay(input: { termId?: string; date: string; reason?: string }) {
  const term: any = input.termId ? await need(Term.findById(input.termId).lean(), 'Term') : await resolveTerm();
  await assertTermOpen(term._id);
  if (await NonSchoolDay.exists({ termId: term._id, date: input.date })) throw validation('That day is already a holiday.', { date: 'Already a holiday.' });
  const d = await NonSchoolDay.create({ termId: term._id, date: input.date, reason: input.reason });
  await audit({ action: 'attendance.holiday.add', entityType: 'nonSchoolDay', entityId: d._id, after: { date: input.date, reason: input.reason } });
  return d;
}

export async function removeNonSchoolDay(id: string) {
  const d: any = await need(NonSchoolDay.findById(id), 'Holiday');
  await assertTermOpen(d.termId);
  await NonSchoolDay.deleteOne({ _id: id });
  await audit({ action: 'attendance.holiday.remove', entityType: 'nonSchoolDay', entityId: id, before: { date: d.date } });
}

export { forbidden, getCtx, ClassLevel };
