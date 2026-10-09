import type { ClientSession } from 'mongoose';
import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { formatNumber, nextSeq, seqKeyFor } from '../core/counters';
import { tx } from '../core/db';
import { forbidden, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { can, me } from '../core/http';
import { lagosDate, todayLagos } from '../lib/dates';
import { normalizePhone } from '../lib/phone';
import {
  AcademicSession,
  Application,
  ClassArm,
  ClassLevel,
  Enrolment,
  Guardian,
  Membership,
  Score,
  Student,
  StudentGuardian,
  StudentDocument,
  Term,
  User
} from '../models';
import { sendFamilyLogins } from './accounts';
import { fullName, loadSchool, need } from './common';
import { currentSession, hasFullReach, myTeaching, studentAccess, enrolledStudentIdsInArms } from './reach';
import { photoUrl } from './common';

/**
 * The enrol service (Document 5, M4): create the student, create or link the guardian by phone, the enrolment, the
 * memberships and the invoice, all in one transaction. Used by public admissions (F5), direct admission (F6) and imports.
 */

export interface ChildInput {
  firstName: string;
  middleName?: string;
  lastName: string;
  dob: string;
  gender: 'male' | 'female';
  address?: string;
  stateOfOrigin?: string;
  religion?: string;
  photo?: string;
  medical?: { notes?: string; allergies?: string; emergencyName?: string; emergencyPhone?: string };
}

export interface GuardianInput {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  address?: string;
  occupation?: string;
  relationship?: string;
  isPrimary?: boolean;
  isFeePayer?: boolean;
}

export interface EnrolInput {
  child: ChildInput;
  guardians: GuardianInput[];
  classArmId: string;
  consent?: { onFile?: boolean; text?: string; at?: Date; ip?: string; source?: 'application' | 'paper' | 'import' };
  applicationId?: string;
  admittedOn?: string;
  importBatchId?: string;
  /** from an import: the admission number the school already uses */
  admissionNumber?: string;
  /** send login details now (default: only once the school has gone live) */
  issueLogins?: boolean;
  sessionId?: string;
}

/** Hooks other modules register so enrolment can raise an invoice without a circular import. */
export const enrolHooks: { invoice?: (student: any, enrolment: any, session?: ClientSession) => Promise<void> } = {};

export async function generateAdmissionNumber(session?: ClientSession): Promise<string> {
  const school: any = await loadSchool();
  const format = school.settings?.admissionNumberFormat || 'ADM/{YY}/{SEQ:4}';
  for (let i = 0; i < 5; i++) {
    const seq = await nextSeq(seqKeyFor(format, 'admission'), session);
    const n = formatNumber(format, seq).toUpperCase();
    if (!(await Student.exists({ admissionNumber: n }))) return n;
  }
  throw new Error('Could not generate a unique admission number');
}

/** Duplicate check by the child's name, date of birth and guardian phone. Twins are not flagged: the first name is used as well as the date of birth. */
export async function findDuplicates(child: { firstName: string; lastName: string; dob: string }, guardianPhone?: string, excludeStudentId?: string) {
  const first = new RegExp(`^${child.firstName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const sameDob: any[] = await Student.find({ dob: child.dob, firstName: first, ...(excludeStudentId ? { _id: { $ne: excludeStudentId } } : {}) }).limit(10).lean();
  const phone = guardianPhone ? normalizePhone(guardianPhone) : null;
  const students: any[] = [];
  for (const s of sameDob) {
    const lastMatch = s.lastName.toLowerCase() === child.lastName.trim().toLowerCase();
    let phoneMatch = false;
    if (phone) {
      const links = await StudentGuardian.find({ studentId: s._id }).select('guardianId').lean();
      phoneMatch = !!(await Guardian.exists({ _id: { $in: links.map((l: any) => l.guardianId) }, phone }));
    }
    if (lastMatch || phoneMatch) students.push({ id: String(s._id), admissionNumber: s.admissionNumber, name: fullName(s), dob: s.dob, status: s.status, reason: lastMatch && phoneMatch ? 'Same name, date of birth and guardian phone.' : lastMatch ? 'Same name and date of birth.' : 'Same first name, date of birth and guardian phone.' });
  }
  const apps: any[] = await Application.find({ 'child.dob': child.dob, 'child.firstName': first, status: { $nin: ['draft', 'rejected', 'withdrawn', 'expired'] }, ...(phone ? { 'guardian.phone': phone } : {}) })
    .limit(5)
    .lean();
  return {
    students,
    applications: apps.map((a) => ({ id: String(a._id), number: a.number, status: a.status, name: fullName(a.child) })),
    duplicate: students.length > 0 || apps.length > 0
  };
}

/** Create or link a guardian by phone number inside the school. One guardian record, however many children. */
async function upsertGuardian(g: GuardianInput, session?: ClientSession, importBatchId?: string) {
  const phone = normalizePhone(g.phone);
  if (!phone) throw validation('Enter a valid guardian phone number.', { phone: 'Not a valid phone number.' });
  let doc: any = await Guardian.findOne({ phone }).session(session ?? null);
  if (!doc) {
    [doc] = await Guardian.create([{ firstName: g.firstName, lastName: g.lastName, phone, email: g.email, address: g.address, occupation: g.occupation, importBatchId }], { session });
  }
  return doc;
}

export async function enrolStudent(input: EnrolInput, opts: { session?: ClientSession; sendLogins?: boolean } = {}) {
  const run = async (session: ClientSession | undefined) => {
    const arm: any = await need(ClassArm.findById(input.classArmId).session(session ?? null).lean(), 'Class');
    if (!arm.active) throw validation('This class is switched off.', { classArmId: 'Not available.' });
    const level: any = await need(ClassLevel.findById(arm.classLevelId).session(session ?? null).lean(), 'Class level');
    const acSession: any = input.sessionId ? await AcademicSession.findById(input.sessionId).lean() : await currentSession();
    if (!acSession) throw validation('There is no current session. Create a session first.', { classArmId: 'No current session.' });
    if (!input.guardians.length) throw validation('Add at least one guardian.', { guardians: 'Required.' });

    let admissionNumber: string;
    if (input.admissionNumber) {
      admissionNumber = input.admissionNumber.trim().toUpperCase();
      if (await Student.exists({ admissionNumber })) throw validation('That admission number is already used.', { admissionNumber: 'Already used.' });
    } else admissionNumber = await generateAdmissionNumber(session);
    const [student] = await Student.create(
      [
        {
          admissionNumber,
          ...input.child,
          status: 'active',
          admittedOn: input.admittedOn ?? todayLagos(),
          statusHistory: [{ status: 'active', at: new Date(), date: input.admittedOn ?? todayLagos(), reason: 'Enrolled' }],
          importBatchId: input.importBatchId,
          applicationId: input.applicationId,
          consentOnFile: !!input.consent?.onFile || !!input.consent?.text,
          consent: input.consent ? { text: input.consent.text, at: input.consent.at ?? new Date(), ip: input.consent.ip, source: input.consent.source } : undefined
        }
      ],
      { session }
    );

    const guardians: any[] = [];
    const seen = new Set<string>();
    let primarySet = false;
    for (const g of input.guardians) {
      const doc = await upsertGuardian(g, session, input.importBatchId);
      if (seen.has(String(doc._id))) continue; // two guardians sharing one phone are treated as one
      seen.add(String(doc._id));
      const isPrimary = g.isPrimary ?? !primarySet;
      if (isPrimary) primarySet = true;
      await StudentGuardian.create([{ studentId: student._id, guardianId: doc._id, relationship: g.relationship ?? 'parent', isPrimary, isFeePayer: g.isFeePayer ?? isPrimary, importBatchId: input.importBatchId }], { session });
      guardians.push(doc);
    }
    if (!primarySet && guardians.length) await StudentGuardian.updateOne({ studentId: student._id, guardianId: guardians[0]._id }, { isPrimary: true, isFeePayer: true }, { session });

    const [enrolment] = await Enrolment.create(
      [{ studentId: student._id, sessionId: acSession._id, classLevelId: level._id, classArmId: arm._id, from: input.admittedOn ?? todayLagos(), imported: !!input.importBatchId }],
      { session }
    );
    await Student.updateOne({ _id: student._id }, { currentEnrolmentId: enrolment._id }, { session });
    if (enrolHooks.invoice) await enrolHooks.invoice(student, enrolment, session);
    return { student, guardians, enrolment, level };
  };

  const out = opts.session ? await run(opts.session) : await tx(run);

  await audit({ action: 'students.enrol', entityType: 'student', entityId: out.student._id, after: { admissionNumber: out.student.admissionNumber, classArmId: input.classArmId } });

  // Login details go out once the school is live, or when asked for. Imports never send logins (they go at go-live).
  const school: any = await loadSchool();
  const live = !!school.setupProgress?.liveAt;
  if (!input.importBatchId && school.status === 'active' && (input.issueLogins ?? live) && opts.sendLogins !== false) {
    await sendFamilyLogins({ school, student: out.student, guardians: out.guardians, studentLogin: !!out.level.studentLogin });
  }
  return out;
}

// ------------------------------------------------------------------ viewing

export interface StudentRow {
  id: string;
  admissionNumber: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  gender: string;
  status: string;
  classLevelId?: string;
  classArmId?: string;
  className?: string;
  hasPhoto: boolean;
}

/** The filter that keeps a teacher to their own class arms. Leadership, admin and bursar see everyone. */
export async function visibleStudentFilter(): Promise<Record<string, unknown> | null> {
  const c = me();
  if (hasFullReach() || c.roles.includes('bursar')) return {};
  if (c.roles.includes('class_teacher') || c.roles.includes('subject_teacher')) {
    const t = await myTeaching();
    const ids = await enrolledStudentIdsInArms([...t.arms]);
    return { _id: { $in: ids } };
  }
  return null;
}

export async function classNames(armIds: string[]) {
  const arms: any[] = await ClassArm.find({ _id: { $in: armIds } }).lean();
  const levels = new Map<string, any>((await ClassLevel.find({ _id: { $in: arms.map((a) => a.classLevelId) } }).lean()).map((l: any) => [String(l._id), l]));
  return new Map<string, { name: string; levelId: string }>(arms.map((a) => [String(a._id), { name: `${levels.get(String(a.classLevelId))?.name ?? ''} ${a.name}`.trim(), levelId: String(a.classLevelId) }]));
}

export async function studentRows(students: any[], sessionId?: string): Promise<StudentRow[]> {
  const session = sessionId ?? String((await currentSession())?._id ?? '');
  const enrolments: any[] = session ? await Enrolment.find({ sessionId: session, studentId: { $in: students.map((s) => s._id) } }).lean() : [];
  const byStudent = new Map<string, any>(enrolments.map((e) => [String(e.studentId), e]));
  const names = await classNames([...new Set(enrolments.map((e) => String(e.classArmId)))]);
  return students.map((s) => {
    const e = byStudent.get(String(s._id));
    return {
      id: String(s._id),
      admissionNumber: s.admissionNumber,
      firstName: s.firstName,
      middleName: s.middleName,
      lastName: s.lastName,
      gender: s.gender,
      status: s.status,
      classLevelId: e ? String(e.classLevelId) : undefined,
      classArmId: e ? String(e.classArmId) : undefined,
      className: e ? names.get(String(e.classArmId))?.name : undefined,
      hasPhoto: !!s.photo,
      photoUrl: photoUrl(s.photo)
    };
  });
}

/** One student. Fields returned depend on the caller's permissions and reach (Document 2, section 1). */
export async function studentView(id: string) {
  const c = me();
  const s: any = await need(Student.findById(id).lean(), 'Student');
  const access = await studentAccess(id);
  if (access === 'none') throw notFound('Student');
  const [row] = await studentRows([s]);
  const base: any = { ...row, photo: s.photo ? s.photo : undefined, photoUrl: photoUrl(s.photo), alumni: !!s.alumni };

  // Subject teachers and the bursar see names, class and photograph. Not the full profile.
  const full = access === 'full' ? !c.roles.includes('bursar') : true;
  const minimal = c.roles.includes('subject_teacher') && !c.roles.includes('class_teacher') && access === 'own_arm';
  if (full && !minimal) {
    Object.assign(base, { dob: s.dob, address: s.address, stateOfOrigin: s.stateOfOrigin, religion: s.religion, admittedOn: s.admittedOn, statusHistory: s.statusHistory, consentOnFile: s.consentOnFile });
    if (can('students.medical.view')) base.medical = s.medical;
  }
  if (access === 'children' || access === 'self') base.dob = s.dob;
  return base;
}

// ------------------------------------------------------------------ changes

export async function updateStudentProfile(id: string, patch: Partial<ChildInput>) {
  const s: any = await need(Student.findById(id), 'Student');
  const before = { firstName: s.firstName, lastName: s.lastName, dob: s.dob };
  const { medical, ...rest } = patch;
  Object.assign(s, rest);
  if (medical) for (const [k, v] of Object.entries(medical)) s.set(`medical.${k}`, v);
  await s.save();
  await audit({ action: 'students.update', entityType: 'student', entityId: id, before, after: { ...rest, ...(medical ? { medical: '[changed]' } : {}) } });
  return s;
}

export async function changeStudentStatus(id: string, input: { status: 'active' | 'suspended' | 'withdrawn' | 'transferred' | 'graduated'; date: string; reason: string; classArmId?: string }) {
  const c = me();
  const s: any = await need(Student.findById(id), 'Student');
  assertTransition('student', s.status, input.status, 'This student');
  const from = s.status;
  const session = await currentSession();

  s.status = input.status;
  s.statusHistory.push({ status: input.status, at: new Date(), date: input.date, reason: input.reason, by: c.userId });
  if (input.status === 'graduated') s.alumni = true;

  const leaving = ['withdrawn', 'transferred', 'graduated'].includes(input.status);
  if (leaving && session) {
    // The student is removed from class lists from that date. Open invoices remain on the statement.
    await Enrolment.updateOne({ studentId: id, sessionId: session._id }, { to: input.date, outcome: input.status === 'graduated' ? 'graduated' : 'left' });
  }
  if (from !== 'active' && input.status === 'active' && ['withdrawn', 'transferred'].includes(from)) {
    // Readmission, by admin, needs a class.
    if (!input.classArmId) throw validation('Choose the class to readmit the student into.', { classArmId: 'Required for readmission.' });
    const arm: any = await need(ClassArm.findById(input.classArmId).lean(), 'Class');
    if (!session) throw validation('There is no current session.');
    await Enrolment.updateOne({ studentId: id, sessionId: session._id }, { $set: { classLevelId: arm.classLevelId, classArmId: arm._id }, $unset: { to: 1, outcome: 1 }, $setOnInsert: { from: input.date } }, { upsert: true });
    s.alumni = false;
  }
  await s.save();

  // The student login follows the status. The parent keeps access to that child's past results and receipts.
  if (s.userId) {
    const status = ['active'].includes(input.status) ? 'active' : leaving || input.status === 'suspended' ? 'deactivated' : 'active';
    await Membership.updateMany({ userId: s.userId, schoolId: getCtx()!.schoolId, kind: 'student' }, { status, $inc: { permVersion: 1 } });
  }
  await audit({ action: 'students.status', entityType: 'student', entityId: id, before: { status: from }, after: { status: input.status, date: input.date }, reason: input.reason });
  return s;
}

/** Move to another class arm in the current session. Scores already entered move with the student. Attendance stays with the register it was taken on. */
export async function moveStudent(id: string, classArmId: string, date: string = todayLagos()) {
  const session = await currentSession();
  if (!session) throw validation('There is no current session.');
  const arm: any = await need(ClassArm.findById(classArmId).lean(), 'Class');
  if (!arm.active) throw validation('This class is switched off.', { classArmId: 'Not available.' });
  const e: any = await need(Enrolment.findOne({ studentId: id, sessionId: session._id }), 'Enrolment');
  const before = { classArmId: String(e.classArmId), classLevelId: String(e.classLevelId) };
  if (before.classArmId === classArmId) throw stateConflict('The student is already in this class.');
  e.classLevelId = arm.classLevelId;
  e.classArmId = arm._id;
  await e.save();
  const term = await Term.findOne({ status: 'current' }).select('_id').lean();
  if (term) await Score.updateMany({ studentId: id, termId: term._id }, { classArmId: arm._id });
  await audit({ action: 'students.move', entityType: 'student', entityId: id, before, after: { classArmId, date } });
  return e;
}

// ------------------------------------------------------------------ guardians

export async function guardianLinks(studentId: string) {
  const links: any[] = await StudentGuardian.find({ studentId }).sort({ isPrimary: -1, createdAt: 1 }).lean();
  const gs = new Map<string, any>((await Guardian.find({ _id: { $in: links.map((l) => l.guardianId) } }).lean()).map((g: any) => [String(g._id), g]));
  return links.map((l) => {
    const g = gs.get(String(l.guardianId));
    return { guardianId: String(l.guardianId), firstName: g?.firstName, lastName: g?.lastName, phone: g?.phone, email: g?.email, address: g?.address, relationship: l.relationship, isPrimary: l.isPrimary, isFeePayer: l.isFeePayer, access: l.access, hasLogin: !!g?.userId };
  });
}

export async function linkGuardian(studentId: string, input: GuardianInput & { guardianId?: string }) {
  await need(Student.findById(studentId).select('_id').lean(), 'Student');
  let guardian: any;
  if (input.guardianId) guardian = await need(Guardian.findById(input.guardianId), 'Guardian');
  else guardian = await upsertGuardian(input);
  if (await StudentGuardian.exists({ studentId, guardianId: guardian._id })) throw stateConflict('This guardian is already linked to the student.');
  const hasAny = await StudentGuardian.exists({ studentId });
  await StudentGuardian.create({ studentId, guardianId: guardian._id, relationship: input.relationship ?? 'guardian', isPrimary: input.isPrimary ?? !hasAny, isFeePayer: input.isFeePayer ?? !hasAny });
  if (input.isPrimary) await StudentGuardian.updateMany({ studentId, guardianId: { $ne: guardian._id } }, { isPrimary: false });
  await audit({ action: 'students.guardian.link', entityType: 'student', entityId: studentId, after: { guardianId: String(guardian._id) } });
  return guardian;
}

export async function updateGuardianLink(studentId: string, guardianId: string, patch: { relationship?: string; isPrimary?: boolean; isFeePayer?: boolean; access?: 'full' | 'view' | 'none'; reason?: string }) {
  const link: any = await need(StudentGuardian.findOne({ studentId, guardianId }), 'Guardian link');
  if (patch.access && patch.access !== link.access) {
    // Separated parents: the school can limit a guardian to view only, or remove their access. A staff action with a logged reason.
    if (!patch.reason) throw validation('Give a reason for changing this guardian’s access.', { reason: 'Required.' });
    if (patch.access === 'none') {
      const others = await StudentGuardian.countDocuments({ studentId, guardianId: { $ne: guardianId }, access: { $ne: 'none' } });
      if (!others) throw stateConflict('The last guardian with access cannot be removed.');
    }
    await audit({ action: 'students.guardian.access', entityType: 'student', entityId: studentId, before: { access: link.access }, after: { access: patch.access, guardianId }, reason: patch.reason });
    link.access = patch.access;
    link.accessReason = patch.reason;
  }
  if (patch.relationship) link.relationship = patch.relationship;
  if (patch.isFeePayer !== undefined) link.isFeePayer = patch.isFeePayer;
  if (patch.isPrimary !== undefined) {
    link.isPrimary = patch.isPrimary;
    if (patch.isPrimary) await StudentGuardian.updateMany({ studentId, guardianId: { $ne: guardianId } }, { isPrimary: false });
  }
  await link.save();
  return link;
}

export async function unlinkGuardian(studentId: string, guardianId: string) {
  await need(StudentGuardian.findOne({ studentId, guardianId }).lean(), 'Guardian link');
  if ((await StudentGuardian.countDocuments({ studentId })) <= 1) throw stateConflict('The last guardian cannot be removed.');
  await StudentGuardian.deleteOne({ studentId, guardianId });
  const first: any = await StudentGuardian.findOne({ studentId }).sort({ createdAt: 1 }).lean();
  if (first && !(await StudentGuardian.exists({ studentId, isPrimary: true }))) await StudentGuardian.updateOne({ _id: first._id }, { isPrimary: true });
  await audit({ action: 'students.guardian.unlink', entityType: 'student', entityId: studentId, after: { guardianId } });
}

export async function updateGuardian(id: string, patch: { firstName?: string; lastName?: string; phone?: string; email?: string; address?: string; occupation?: string }) {
  const g: any = await need(Guardian.findById(id), 'Guardian');
  if (patch.phone) {
    const phone = normalizePhone(patch.phone);
    if (!phone) throw validation('Enter a valid phone number.', { phone: 'Not a valid phone number.' });
    if (phone !== g.phone) {
      if (await Guardian.exists({ phone, _id: { $ne: id } })) throw validation('Another guardian at this school uses that phone number.', { phone: 'Already used.' });
      if (g.userId) {
        if (await User.exists({ phone, _id: { $ne: g.userId } })) throw validation('That phone number belongs to another account.', { phone: 'Already used.' });
        await User.updateOne({ _id: g.userId }, { phone });
      }
      patch.phone = phone;
    }
  }
  const before = { phone: g.phone, email: g.email };
  Object.assign(g, patch);
  await g.save();
  await audit({ action: 'guardians.update', entityType: 'guardian', entityId: id, before, after: { phone: g.phone, email: g.email } });
  return g;
}

// ------------------------------------------------------------------ documents

export async function listDocuments(studentId: string) {
  const access = await studentAccess(studentId);
  if (access === 'none') throw notFound('Student');
  const filter: any = { ownerType: 'student', ownerId: studentId };
  if (access === 'children' || access === 'self') filter.visibleToGuardian = true; // where the school allows, parents see documents
  return StudentDocument.find(filter).sort({ createdAt: -1 }).lean();
}

export const todayDate = () => lagosDate();
export { forbidden };
