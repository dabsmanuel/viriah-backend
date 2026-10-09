import { can, me } from '../core/http';
import { attendancePercent } from '../calc/results';
import { todayLagos } from '../lib/dates';
import { AcademicSession, Application, ClassArm, ClassSubject, Enrolment, Guardian, Invoice, NonSchoolDay, Payment, Score, ScoreSheet, Staff, Student, StudentGuardian, Subject, Submission, Task, TeachingAssignment, Term, TermResult, AttendanceRegister, ClassResult } from '../models';
import { pendingApprovals } from './approvals';
import { armStudents, subjectRoster } from './academics';
import { studentTermTotals } from './attendance';
import { visibleAnnouncements, announcementView } from './comms';
import { fullName, need } from './common';
import { attendanceToday, enrolmentReport, financeReport } from './reports';
import { currentSession, currentTerm, myChildIds, myTeaching, studentAccess } from './reach';
import { resultBlock } from './results';
import { myTasks } from './tasks';
import { classNames } from './students';
import { publicUrl } from '../integrations/storage';
import { photoUrl } from './common';

/** The home screen data for the caller's current role (OWN-01, TCH-01, POR-01, POR-02). */

async function childCard(studentId: string) {
  const s: any = await need(Student.findById(studentId).lean(), 'Student');
  const session = await currentSession();
  const term: any = await currentTerm();
  const e: any = session ? await Enrolment.findOne({ studentId, sessionId: session._id }).lean() : null;
  const names = e ? await classNames([String(e.classArmId)]) : new Map();
  const invs: any[] = await Invoice.find({ studentId, status: { $in: ['issued', 'part_paid'] } }).select('balanceKobo dueOn').lean();
  const today = todayLagos();
  const latest: any = await TermResult.findOne({ studentId, published: true }).sort({ updatedAt: -1 }).lean();
  let latestResult: any = null;
  if (latest) {
    const t: any = await Term.findById(latest.termId).lean();
    const block = await resultBlock(studentId, latest);
    latestResult = { termId: String(latest.termId), term: t?.number, average: block.blocked ? null : latest.average ?? null, position: block.blocked ? null : latest.position ?? null, classSize: latest.classSize, blocked: block.blocked, message: (block as any).message, revision: latest.revision ?? 0 };
  }
  let workDue = 0;
  let attendance: any = null;
  if (term && e) {
    workDue = (await myTasksFor(studentId)).filter((t) => t.state === 'due' || t.state === 'returned').length;
    attendance = await studentTermTotals(studentId, String(term._id));
  }
  return {
    studentId,
    name: fullName(s),
    admissionNumber: s.admissionNumber,
    class: e ? names.get(String(e.classArmId))?.name : null,
    photo: s.photo ? true : false,
    photoUrl: photoUrl(s.photo),
    feeBalanceKobo: invs.reduce((a, i) => a + i.balanceKobo, 0),
    overdueKobo: invs.filter((i) => i.dueOn && i.dueOn < today).reduce((a, i) => a + i.balanceKobo, 0),
    latestResult,
    workDue,
    attendance
  };
}

// myTasks resolves the acting student from the caller. For a parent it needs the child id; call it with that.
const myTasksFor = (studentId: string) => myTasks(studentId);

export async function parentDashboard() {
  const kids = await myChildIds();
  const children = await Promise.all(kids.map(childCard));
  const ann = (await visibleAnnouncements()).slice(0, 5).map((a) => announcementView(a, false));
  return { role: 'parent', children, announcements: ann };
}

export async function studentOverview(studentId: string) {
  const card = await childCard(studentId);
  const subjects = await subjectsWithTeachers(studentId);
  const tasks = await myTasks(studentId);
  const recent = tasks.filter((t) => t.state === 'marked').slice(0, 5).map((t) => ({ taskId: t.id, title: t.title, subject: t.subject, score: t.submission?.score, maxScore: t.maxScore }));
  const results = await TermResult.find({ studentId, published: true }).select('termId average position classSize revision').lean();
  const ann = (await visibleAnnouncements()).slice(0, 5).map((a) => announcementView(a, false));
  const showFees = false;
  return { role: 'student', student: { id: studentId, name: card.name, class: card.class }, subjects, workDue: tasks.filter((t) => t.state === 'due' || t.state === 'returned').slice(0, 10), recentScores: recent, results: results.map((r: any) => ({ termId: String(r.termId), average: r.average, position: r.position, classSize: r.classSize })), announcements: ann, attendance: card.attendance, ...(showFees ? { feeBalanceKobo: card.feeBalanceKobo } : {}) };
}

/** Subjects this term with the teacher of each. */
export async function subjectsWithTeachers(studentId: string) {
  const session = await currentSession();
  const term: any = await currentTerm();
  if (!session || !term) return [];
  const e: any = await Enrolment.findOne({ studentId, sessionId: session._id }).lean();
  if (!e) return [];
  const cs: any[] = await ClassSubject.find({ classLevelId: e.classLevelId }).lean();
  const offered: any[] = [];
  for (const x of cs) {
    const roster = await subjectRoster(String(e.classArmId), String(x.subjectId), String(term._id), session._id);
    if (roster.some((s) => String(s._id) === studentId)) offered.push(x);
  }
  const subs = new Map<string, any>((await Subject.find({ _id: { $in: offered.map((o) => o.subjectId) } }).lean()).map((s: any) => [String(s._id), s]));
  const assigns: any[] = await TeachingAssignment.find({ sessionId: session._id, classArmId: e.classArmId, kind: 'subject_teacher' }).lean();
  const staff = new Map<string, any>((await Staff.find({ _id: { $in: assigns.map((a) => a.staffId) } }).select('firstName lastName photo').lean()).map((s: any) => [String(s._id), s]));
  return offered
    .map((o) => {
      const a = assigns.find((x) => String(x.subjectId) === String(o.subjectId));
      return { subjectId: String(o.subjectId), name: subs.get(String(o.subjectId))?.name, compulsory: o.compulsory, teacher: a ? fullName(staff.get(String(a.staffId))) : null };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function teacherDashboard() {
  const c = me();
  const t = await myTeaching();
  const term: any = await currentTerm();
  const session = await currentSession();
  const today = todayLagos();
  const assignments: any[] = c.staffId && session ? await TeachingAssignment.find({ sessionId: session._id, staffId: c.staffId, draft: { $ne: true } }).lean() : [];
  const armIds = [...new Set(assignments.map((a) => String(a.classArmId)))];
  const names = await classNames(armIds);
  const subjects = new Map<string, any>((await Subject.find({ _id: { $in: assignments.map((a) => a.subjectId).filter(Boolean) } }).lean()).map((s: any) => [String(s._id), s]));

  let registersNotTaken = 0;
  const registersMissing: any[] = [];
  const holiday = await NonSchoolDay.exists({ date: today });
  for (const arm of t.classTeacherArms) {
    if (holiday) continue;
    const taken = await AttendanceRegister.exists({ classArmId: arm, date: today });
    if (!taken && (await Enrolment.exists({ classArmId: arm, sessionId: session?._id, to: { $exists: false } }))) {
      registersNotTaken += 1;
      registersMissing.push({ classArmId: arm, class: names.get(arm)?.name });
    }
  }

  let toMark = 0;
  let sheetsNotSubmitted = 0;
  let waitingComments = 0;
  if (term) {
    for (const [arm, subs] of t.subjectsByArm) {
      for (const sid of subs) {
        const tasks: any[] = await Task.find({ termId: term._id, classArmId: arm, subjectId: sid, status: { $in: ['published', 'closed'] } }).select('_id').lean();
        toMark += await Submission.countDocuments({ taskId: { $in: tasks.map((x) => x._id) }, status: 'submitted' });
        const roster = await subjectRoster(arm, sid, String(term._id), term.sessionId);
        if (roster.length) {
          const sheet: any = await ScoreSheet.findOne({ termId: term._id, classArmId: arm, subjectId: sid }).lean();
          if (sheet?.status !== 'submitted') sheetsNotSubmitted += 1;
        }
      }
    }
    for (const arm of t.classTeacherArms) {
      const cr: any = await ClassResult.findOne({ termId: term._id, classArmId: arm }).lean();
      if (cr && ['open', 'compiled', 'reopened'].includes(cr.status)) {
        const students = await armStudents(arm, term.sessionId);
        const trs: any[] = await TermResult.find({ termId: term._id, studentId: { $in: students.map((s) => s._id) } }).select('studentId teacherComment').lean();
        waitingComments += students.length - trs.filter((r) => r.teacherComment).length;
      }
    }
  }
  const ann = (await visibleAnnouncements()).slice(0, 5).map((a) => announcementView(a, false));
  return {
    role: 'teacher',
    classes: assignments.map((a) => ({ classArmId: String(a.classArmId), class: names.get(String(a.classArmId))?.name, subject: a.subjectId ? subjects.get(String(a.subjectId))?.name : null, subjectId: a.subjectId ? String(a.subjectId) : null, kind: a.kind })),
    todo: { registersNotTaken, registersMissing, submissionsToMark: toMark, sheetsNotSubmitted, resultsWaitingForComments: waitingComments },
    announcements: ann
  };
}

export async function leadershipDashboard() {
  const term: any = await currentTerm();
  const today = todayLagos();
  const enrol = await enrolmentReport();
  const attendance = await attendanceToday(today);
  const finance = can('fees.reports.view') ? await financeReport() : null;
  const applications = await Application.countDocuments({ status: { $in: ['submitted', 'under_review', 'assessment_scheduled'] } });
  let scoreProgress: any[] = [];
  if (term) {
    const arms: any[] = await ClassArm.find({ active: true }).lean();
    const names = await classNames(arms.map((a) => String(a._id)));
    for (const a of arms) {
      const students = await Enrolment.countDocuments({ sessionId: term.sessionId, classArmId: a._id, to: { $exists: false } });
      if (!students) continue;
      const arm: any = a;
      const cs = await ClassSubject.countDocuments({ classLevelId: arm.classLevelId });
      const submitted = await ScoreSheet.countDocuments({ termId: term._id, classArmId: a._id, status: 'submitted' });
      const cr: any = await ClassResult.findOne({ termId: term._id, classArmId: a._id }).select('status').lean();
      scoreProgress.push({ classArmId: String(a._id), class: names.get(String(a._id))?.name, sheetsSubmitted: submitted, sheetsTotal: cs, resultStatus: cr?.status ?? 'open' });
    }
    scoreProgress = scoreProgress.sort((x, y) => String(x.class).localeCompare(String(y.class)));
  }
  const approvals = can('approvals.view') ? (await pendingApprovals()).counts : null;
  const ann = (await visibleAnnouncements()).slice(0, 5).map((a) => announcementView(a, true));
  return {
    role: 'leadership',
    term: term ? term.number : null,
    enrolment: { total: enrol.total.total, byClass: enrol.rows },
    fees: finance ? { expectedKobo: finance.totals.expectedKobo, collectedKobo: finance.totals.collectedKobo, outstandingKobo: finance.totals.outstandingKobo } : null,
    attendanceToday: attendance,
    scoreEntry: scoreProgress,
    applicationsWaiting: applications,
    approvals,
    announcements: ann
  };
}

export async function bursarDashboard() {
  const finance = await financeReport();
  const proofs = await Payment.countDocuments({ status: 'pending_confirmation' });
  const flagged = await Payment.countDocuments({ flagged: true, status: 'successful' });
  const debtors = await Invoice.aggregate([{ $match: { status: { $in: ['issued', 'part_paid'] }, balanceKobo: { $gt: 0 } } }, { $group: { _id: '$studentId' } }, { $count: 'n' }]);
  return { role: 'bursar', fees: finance.totals, debtors: debtors[0]?.n ?? 0, proofsToConfirm: proofs, flaggedPayments: flagged };
}

/** The payload for the caller's current role. A person with several staff roles gets the sections that apply. */
export async function dashboard() {
  const c = me();
  if (c.kind === 'platform') return { role: 'super_admin' };
  if (c.roles.includes('parent')) return parentDashboard();
  if (c.roles.includes('student') && c.studentId) return studentOverview(c.studentId);
  const out: any = { role: 'staff', roles: c.roles };
  if (c.roles.some((r) => ['owner', 'principal', 'school_admin'].includes(r))) out.leadership = await leadershipDashboard();
  if (c.roles.some((r) => ['class_teacher', 'subject_teacher'].includes(r))) out.teacher = await teacherDashboard();
  if (c.roles.includes('bursar')) out.bursar = await bursarDashboard();
  return out;
}

export async function myChildren() {
  const ids = await myChildIds();
  const session = await currentSession();
  const students: any[] = await Student.find({ _id: { $in: ids } }).lean();
  const enrol: any[] = session ? await Enrolment.find({ sessionId: session._id, studentId: { $in: ids } }).lean() : [];
  const names = await classNames([...new Set(enrol.map((e) => String(e.classArmId)))]);
  return students.map((s) => {
    const e = enrol.find((x) => String(x.studentId) === String(s._id));
    return { studentId: String(s._id), name: fullName(s), admissionNumber: s.admissionNumber, status: s.status, class: e ? names.get(String(e.classArmId))?.name : null, hasPhoto: !!s.photo, photoUrl: photoUrl(s.photo) };
  });
}

export { studentAccess, publicUrl, AcademicSession, Guardian, StudentGuardian, Score, attendancePercent };
