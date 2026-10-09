import { audit } from '../core/audit';
import { tx } from '../core/db';
import { forbidden, stateConflict, validation, duplicate } from '../core/errors';
import { me } from '../core/http';
import { canAssignRole, GRANTABLE_EXTRAS, STAFF_ROLES, type Role } from '../core/permissions';
import { schoolLink } from '../lib/links';
import { AcademicSession, AuthSession, ClassArm, ClassLevel, Membership, ScoreSheet, Staff, Subject, TeachingAssignment, User, Task } from '../models';
import { adminResetPassword } from './auth';
import { inviteStaffMember, currentSchoolRef } from './accounts';
import { need, loadSchool, fullName } from './common';
import { notify } from './notify';
import { currentSession } from './reach';
import { normalizePhone } from '../lib/phone';

/** Staff, roles and what they are assigned to teach (STF-01 to STF-04). */

const EXTRA_RULES: Record<string, Role[]> = {
  'admissions.review': ['class_teacher', 'subject_teacher'], // admissions review for a teacher
  'fees.reports.view': ['principal'], // finance summary view for the principal
  'fees.discount.approve': ['principal'], // discount approval for the principal
  'scores.enter': ['school_admin'] // score entry on behalf of teachers, for a school admin
};

function assertRolesAssignable(roles: string[]) {
  const actor = me();
  if (!roles.length) throw validation('Give the staff member at least one role.', { roles: 'Required.' });
  for (const r of roles) {
    if (!STAFF_ROLES.includes(r as Role)) throw validation(`${r} is not a staff role.`, { roles: 'Not a staff role.' });
    if (!canAssignRole(actor.roles, r)) throw forbidden(`You cannot assign the ${r.replace('_', ' ')} role. Ask the owner.`);
  }
}

/** Is the target someone this actor may not change? An admin cannot touch an owner or principal. */
async function assertCanManage(staff: any) {
  const actor = me();
  if (actor.roles.includes('owner')) return;
  if (staff.roles?.some((r: string) => ['owner', 'principal'].includes(r))) throw forbidden('Only the owner can change an owner or a principal.');
}

export async function addStaff(input: { firstName: string; lastName: string; phone: string; email?: string; roles: string[]; qualifications?: string; employedOn?: string }) {
  assertRolesAssignable(input.roles);
  const phone = normalizePhone(input.phone)!;
  if (await Staff.exists({ phone })) throw duplicate('A staff member with this phone number already exists.');
  const school: any = await currentSchoolRef();
  const staff: any = await Staff.create({ ...input, phone, status: 'invited' });
  const invite = await inviteStaffMember(staff, school, input.roles);
  await audit({ action: 'staff.create', entityType: 'staff', entityId: staff._id, after: { roles: input.roles } });
  return { staff, invite };
}

export async function setStaffRoles(id: string, roles: string[], extraPermissions: string[] = []) {
  const staff: any = await need(Staff.findById(id), 'Staff member');
  await assertCanManage(staff);
  assertRolesAssignable(roles);
  for (const e of extraPermissions) {
    if (!(GRANTABLE_EXTRAS as readonly string[]).includes(e)) throw validation(`${e} cannot be granted as an extra permission.`, { extraPermissions: 'Not grantable.' });
    if (!roles.some((r) => EXTRA_RULES[e]?.includes(r as Role))) throw validation(`${e} can only be granted to ${EXTRA_RULES[e].join(' or ').replace(/_/g, ' ')}.`, { extraPermissions: 'Does not fit these roles.' });
  }
  const before = { roles: staff.roles };
  // The school always keeps an owner.
  if (staff.roles.includes('owner') && !roles.includes('owner')) {
    const others = await Staff.countDocuments({ _id: { $ne: staff._id }, roles: 'owner', status: { $ne: 'deactivated' } });
    if (!others) throw stateConflict('The school must keep an owner. Ask the platform team to transfer ownership first.');
  }
  staff.roles = roles;
  await staff.save();
  await Membership.updateOne({ staffId: staff._id, kind: 'staff' }, { roles, extraPermissions, $inc: { permVersion: 1 } });
  await audit({ action: 'staff.roles.update', entityType: 'staff', entityId: id, before, after: { roles, extraPermissions } });
  return staff;
}

export async function deactivateStaff(id: string) {
  const staff: any = await need(Staff.findById(id), 'Staff member');
  await assertCanManage(staff);
  const session = await currentSession();
  // Their classes and subjects are listed for reassignment before the change completes.
  const assignments: any[] = session ? await TeachingAssignment.find({ sessionId: session._id, staffId: id }).lean() : [];
  if (assignments.length) {
    const arms = new Map<string, any>((await ClassArm.find({ _id: { $in: assignments.map((a) => a.classArmId) } }).lean()).map((a: any) => [String(a._id), a]));
    const levels = new Map<string, any>((await ClassLevel.find({ _id: { $in: [...arms.values()].map((a) => a.classLevelId) } }).lean()).map((l: any) => [String(l._id), l]));
    const subs = new Map<string, any>((await Subject.find({ _id: { $in: assignments.map((a) => a.subjectId).filter(Boolean) } }).lean()).map((s: any) => [String(s._id), s]));
    throw stateConflict('This person still has classes or subjects. Reassign them first.', {
      assignments: assignments.map((a) => ({ classArmId: String(a.classArmId), class: `${levels.get(String(arms.get(String(a.classArmId))?.classLevelId))?.name ?? ''} ${arms.get(String(a.classArmId))?.name ?? ''}`.trim(), subjectId: a.subjectId ? String(a.subjectId) : undefined, subject: a.subjectId ? subs.get(String(a.subjectId))?.name : undefined, kind: a.kind }))
    });
  }
  if (staff.roles.includes('owner') && !(await Staff.exists({ _id: { $ne: staff._id }, roles: 'owner', status: 'active' }))) throw stateConflict('The school must keep an owner.');
  staff.status = 'deactivated';
  await staff.save();
  const m: any = await Membership.findOneAndUpdate({ staffId: staff._id, kind: 'staff' }, { status: 'deactivated', $inc: { permVersion: 1 } }, { new: true });
  if (m) await AuthSession.updateMany({ membershipId: m._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
  await audit({ action: 'staff.deactivate', entityType: 'staff', entityId: id });
  return staff;
}

export async function reactivateStaff(id: string) {
  const staff: any = await need(Staff.findById(id), 'Staff member');
  if (staff.status !== 'deactivated') throw stateConflict('This staff member is not deactivated.');
  staff.status = staff.userId ? 'active' : 'invited';
  await staff.save();
  await Membership.updateOne({ staffId: staff._id, kind: 'staff' }, { status: 'active', $inc: { permVersion: 1 } });
  await audit({ action: 'staff.reactivate', entityType: 'staff', entityId: id });
  return staff;
}

export async function resendInvite(id: string) {
  const staff: any = await need(Staff.findById(id), 'Staff member');
  if (staff.status === 'deactivated') throw stateConflict('Reactivate this person first.');
  if (staff.userId && staff.status === 'active') throw stateConflict('This person has already set a password. Use reset password instead.');
  const school: any = await currentSchoolRef();
  return inviteStaffMember(staff, school, staff.roles);
}

/** Send a reset to the staff member: a new temporary password by SMS, and a forced change at next sign in. Logged. */
export async function resetStaffPassword(id: string) {
  const staff: any = await need(Staff.findById(id), 'Staff member');
  await assertCanManage(staff);
  if (!staff.userId) throw stateConflict('This person has not accepted the invite yet. Resend the invite instead.');
  const { temp } = await adminResetPassword(String(staff.userId), 'Reset by school admin');
  const school: any = await loadSchool();
  await notify({ event: 'temp_password', to: [{ userId: String(staff.userId), phone: staff.phone, email: staff.email, kind: 'staff' }], vars: { password: temp, link: schoolLink(school.slug, '/portal/login') } });
  return { sent: true };
}

// ------------------------------------------------------------------ teaching assignments

export interface AssignmentItem {
  classArmId: string;
  subjectId?: string;
  staffId: string | null;
  kind: 'class_teacher' | 'subject_teacher';
}

/** Assign a subject teacher to each subject in each class arm, and a class teacher to each arm, per session. */
export async function setTeachingAssignments(sessionId: string | undefined, items: AssignmentItem[], opts: { draft?: boolean } = {}) {
  const session: any = sessionId ? await need(AcademicSession.findById(sessionId).lean(), 'Session') : await currentSession();
  if (!session) throw validation('There is no current session.');
  const results = { set: 0, removed: 0 };

  await tx(async (s) => {
    for (const it of items) {
      await need(ClassArm.findById(it.classArmId).lean(), 'Class');
      if (it.kind === 'subject_teacher') {
        if (!it.subjectId) throw validation('Choose the subject.', { subjectId: 'Required.' });
        await need(Subject.findById(it.subjectId).lean(), 'Subject');
      }
      const key = { sessionId: session._id, classArmId: it.classArmId, subjectId: it.kind === 'subject_teacher' ? it.subjectId : null, kind: it.kind };
      if (it.staffId === null) {
        const r = await TeachingAssignment.deleteOne({ sessionId: session._id, classArmId: it.classArmId, ...(it.kind === 'subject_teacher' ? { subjectId: it.subjectId } : { subjectId: { $exists: false } }), kind: it.kind }, { session: s });
        results.removed += r.deletedCount;
        continue;
      }
      const staff: any = await need(Staff.findById(it.staffId).session(s ?? null), 'Staff member');
      if (staff.status === 'deactivated') throw validation('That staff member is deactivated.', { staffId: 'Deactivated.' });
      // The right role follows the assignment.
      if (!staff.roles.includes(it.kind)) {
        const roles = [...staff.roles, it.kind];
        await Staff.updateOne({ _id: staff._id }, { roles }, { session: s });
        await Membership.updateOne({ staffId: staff._id, kind: 'staff' }, { $addToSet: { roles: it.kind }, $inc: { permVersion: 1 } }, { session: s });
      }
      const where: any = { sessionId: session._id, classArmId: it.classArmId, kind: it.kind };
      if (it.kind === 'subject_teacher') where.subjectId = it.subjectId;
      else where.subjectId = { $exists: false };
      const prev: any = await TeachingAssignment.findOne(where).session(s ?? null);
      if (prev) {
        await TeachingAssignment.updateOne({ _id: prev._id }, { staffId: it.staffId, draft: !!opts.draft }, { session: s });
        // A teacher leaves mid-term: their score sheets and tasks stay, and the new teacher takes over the same sheets.
        if (String(prev.staffId) !== it.staffId && it.kind === 'subject_teacher') {
          await ScoreSheet.updateMany({ classArmId: it.classArmId, subjectId: it.subjectId, staffId: prev.staffId }, { staffId: it.staffId }, { session: s });
          await Task.updateMany({ classArmId: it.classArmId, subjectId: it.subjectId, staffId: prev.staffId, status: { $ne: 'closed' } }, { staffId: it.staffId }, { session: s });
        }
      } else {
        await TeachingAssignment.create([{ sessionId: session._id, classArmId: it.classArmId, subjectId: it.kind === 'subject_teacher' ? it.subjectId : undefined, staffId: it.staffId, kind: it.kind, draft: !!opts.draft }], { session: s });
      }
      void key;
      results.set += 1;
    }
  });
  await audit({ action: 'staff.assignments.update', entityType: 'session', entityId: session._id, after: results });
  return results;
}

export async function assignmentsView(filter: { sessionId?: string; classArmId?: string; staffId?: string }) {
  const session: any = filter.sessionId ? { _id: filter.sessionId } : await currentSession();
  if (!session) return [];
  const rows: any[] = await TeachingAssignment.find({ sessionId: session._id, ...(filter.classArmId ? { classArmId: filter.classArmId } : {}), ...(filter.staffId ? { staffId: filter.staffId } : {}) }).lean();
  const [arms, staff, subjects] = await Promise.all([
    ClassArm.find({ _id: { $in: rows.map((r) => r.classArmId) } }).lean(),
    Staff.find({ _id: { $in: rows.map((r) => r.staffId) } }).select('firstName lastName').lean(),
    Subject.find({ _id: { $in: rows.map((r) => r.subjectId).filter(Boolean) } }).select('name').lean()
  ]);
  const levels = new Map<string, any>((await ClassLevel.find({ _id: { $in: arms.map((a: any) => a.classLevelId) } }).lean()).map((l: any) => [String(l._id), l]));
  const armMap = new Map<string, any>(arms.map((a: any) => [String(a._id), a]));
  const staffMap = new Map<string, any>(staff.map((s: any) => [String(s._id), s]));
  const subjMap = new Map<string, any>(subjects.map((s: any) => [String(s._id), s]));
  return rows.map((r) => {
    const arm = armMap.get(String(r.classArmId));
    return {
      id: String(r._id),
      sessionId: String(r.sessionId),
      classArmId: String(r.classArmId),
      class: `${levels.get(String(arm?.classLevelId))?.name ?? ''} ${arm?.name ?? ''}`.trim(),
      subjectId: r.subjectId ? String(r.subjectId) : undefined,
      subject: r.subjectId ? subjMap.get(String(r.subjectId))?.name : undefined,
      staffId: String(r.staffId),
      staff: fullName(staffMap.get(String(r.staffId))),
      kind: r.kind,
      draft: !!r.draft
    };
  });
}

export const staffDisplay = (s: any) => ({ id: String(s._id), firstName: s.firstName, lastName: s.lastName, phone: s.phone, email: s.email, roles: s.roles, status: s.status, qualifications: s.qualifications, employedOn: s.employedOn, photo: s.photo });
export { User };
