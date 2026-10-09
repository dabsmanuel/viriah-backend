import { Types } from 'mongoose';
import { getCtx } from '../core/context';
import { forbidden, notFound, validation } from '../core/errors';
import { me } from '../core/http';
import { AcademicSession, ClassArm, Enrolment, Student, StudentGuardian, Term, TeachingAssignment } from '../models';

/**
 * Reach (Document 2, section 1): a permission has two parts, the action and the reach (which records). Reach is what
 * keeps a teacher out of another teacher's class and a parent out of another family's records. The API enforces it.
 * The service layer loads a teacher's teaching assignments for the current session and filters by them, and for a
 * parent it loads their linked students.
 */

export const FULL_REACH_ROLES = ['owner', 'principal', 'school_admin'];

export const hasFullReach = () => !!getCtx()?.roles.some((r) => FULL_REACH_ROLES.includes(r)) || !!getCtx()?.support;

export async function currentSession() {
  return AcademicSession.findOne({ status: 'current' }).lean();
}

export async function currentTerm() {
  return Term.findOne({ status: 'current' }).lean();
}

/** Resolve ?termId=, defaulting to the current term. */
export async function resolveTerm(termId?: string) {
  // With no current term (it was closed), the latest closed term is used, so a change answers term_closed rather than "no term".
  const term = termId ? await Term.findById(termId).lean() : (await currentTerm()) ?? (await Term.findOne({ status: 'closed' }).sort({ closedAt: -1, startDate: -1 }).lean());
  if (!term) throw termId ? notFound('Term') : validation('There is no current term. Open a term first.', { termId: 'No current term.' });
  return term;
}

export interface Teaching {
  /** class arms where the caller is class teacher */
  classTeacherArms: Set<string>;
  /** class arm -> subjects the caller teaches there */
  subjectsByArm: Map<string, Set<string>>;
  /** every arm the caller teaches or looks after */
  arms: Set<string>;
}

/** The caller's teaching assignments for a session (default: the current one). Drafts copied at rollover do not count until confirmed. */
export async function myTeaching(sessionId?: string): Promise<Teaching> {
  const c = getCtx();
  const out: Teaching = { classTeacherArms: new Set(), subjectsByArm: new Map(), arms: new Set() };
  if (!c?.staffId) return out;
  const sid = sessionId ?? (await currentSession())?._id;
  if (!sid) return out;
  const rows = await TeachingAssignment.find({ sessionId: sid, staffId: c.staffId, draft: { $ne: true } }).lean();
  for (const a of rows) {
    const arm = String(a.classArmId);
    out.arms.add(arm);
    if (a.kind === 'class_teacher') out.classTeacherArms.add(arm);
    else if (a.subjectId) {
      if (!out.subjectsByArm.has(arm)) out.subjectsByArm.set(arm, new Set());
      out.subjectsByArm.get(arm)!.add(String(a.subjectId));
    }
  }
  return out;
}

/** Linked children of the signed-in parent. A guardian with access "none" no longer sees the child. */
export async function myChildIds(): Promise<string[]> {
  const c = me();
  if (!c.guardianId) return [];
  const links = await StudentGuardian.find({ guardianId: c.guardianId, access: { $ne: 'none' } }).select('studentId').lean();
  return links.map((l) => String(l.studentId));
}

/** Students a staff member may see: everyone for leadership and admin, the bursar by name, teachers by class arm. */
export async function enrolledStudentIdsInArms(armIds: string[], sessionId?: string): Promise<string[]> {
  const sid = sessionId ?? (await currentSession())?._id;
  if (!sid || !armIds.length) return [];
  const rows = await Enrolment.find({ sessionId: sid, classArmId: { $in: armIds } }).select('studentId').lean();
  return rows.map((r) => String(r.studentId));
}

export async function studentArmId(studentId: string, sessionId?: string): Promise<string | undefined> {
  const sid = sessionId ?? (await currentSession())?._id;
  if (!sid) return undefined;
  const e = await Enrolment.findOne({ studentId, sessionId: sid }).select('classArmId').lean();
  return e ? String(e.classArmId) : undefined;
}

export type Access = 'full' | 'own_arm' | 'children' | 'self' | 'none';

/** Which students may the caller see, and how? Used by every student-scoped endpoint. */
export async function studentAccess(studentId: string): Promise<Access> {
  const c = me();
  if (hasFullReach()) return 'full';
  if (c.roles.includes('bursar')) return 'full'; // names, classes and guardian contacts; other fields are filtered by permission
  if (c.roles.includes('parent')) return (await myChildIds()).includes(studentId) ? 'children' : 'none';
  if (c.roles.includes('student')) return c.studentId === studentId ? 'self' : 'none';
  if (c.roles.includes('class_teacher') || c.roles.includes('subject_teacher')) {
    const arm = await studentArmId(studentId);
    if (!arm) return 'none';
    const t = await myTeaching();
    return t.arms.has(arm) ? 'own_arm' : 'none';
  }
  return 'none';
}

/** A valid ID from another school or another family returns not found, never forbidden, so records cannot be probed. */
export async function assertCanSeeStudent(studentId: string): Promise<Access> {
  const exists = await Student.exists({ _id: studentId });
  if (!exists) throw notFound('Student');
  const a = await studentAccess(studentId);
  if (a === 'none') throw notFound('Student');
  return a;
}

/** A class teacher of this arm, or leadership. */
export async function assertClassTeacherOf(armId: string, allowLeadership = true) {
  const c = me();
  if (allowLeadership && (c.roles.includes('principal') || c.roles.includes('owner'))) return;
  const t = await myTeaching();
  if (!t.classTeacherArms.has(armId)) throw forbidden('Only the class teacher of this class can do this.');
}

/** The teacher of this subject in this arm. Used by score sheets and tasks. */
export async function assertTeaches(armId: string, subjectId: string) {
  const t = await myTeaching();
  if (t.subjectsByArm.get(armId)?.has(subjectId)) return;
  throw forbidden('You do not teach this subject in this class.');
}

export async function assertArmExists(armId: string) {
  const arm = await ClassArm.findById(armId).lean();
  if (!arm) throw notFound('Class');
  return arm;
}

export const oid = (id: string | Types.ObjectId) => new Types.ObjectId(String(id));
