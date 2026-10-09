import type { ClientSession } from 'mongoose';
import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { validation } from '../core/errors';
import { randomPassword, randomToken, sha256 } from '../lib/crypto';
import { daysFromNow, hoursFromNow } from '../lib/dates';
import { schoolLink } from '../lib/links';
import { hashPassword } from '../lib/passwords';
import { Guardian, Invite, Membership, School, Staff, Student, StudentGuardian, User } from '../models';
import { notify } from './notify';
import { fullName } from './common';

/**
 * Account issuing (D4): accounts are issued by the school, not self-registered. Staff are invited. Parent and student
 * accounts are created at enrolment. No member of staff types or sees another person's password: the system creates a
 * temporary password, sends it by SMS, and forces a change at first login (AUTH-03).
 */

const INVITE_HOURS = 72;
const TEMP_PASSWORD_DAYS = 14;

// ------------------------------------------------------------------ staff

/** Invite a staff member. If the phone number already has an account (for example a parent) the invite adds a staff membership and the person signs in with their existing password. */
export async function inviteStaffMember(staff: any, school: { _id: unknown; name: string; slug: string }, roles: string[], opts: { session?: ClientSession } = {}) {
  const schoolId = String(school._id);
  const existing = await User.findOne({ phone: staff.phone }).lean();
  const roleText = roles.map((r) => r.replace(/_/g, ' ')).join(' and ');

  if (existing) {
    await Membership.updateOne(
      { userId: existing._id, schoolId, kind: 'staff' },
      { $set: { roles, staffId: staff._id, status: 'active', invitedAt: new Date(), acceptedAt: new Date() }, $setOnInsert: { permVersion: 1 } },
      { upsert: true, session: opts.session }
    );
    await Staff.updateOne({ _id: staff._id }, { userId: existing._id, status: 'active' }, { session: opts.session });
    await notify({
      schoolId,
      event: 'staff_invite',
      to: [{ phone: staff.phone, email: staff.email, kind: 'staff' }],
      vars: { school: school.name, role: roleText, link: schoolLink(school.slug, '/portal/login') }
    });
    return { token: null as string | null, existingUser: true };
  }

  const token = randomToken(24);
  await Invite.updateMany({ staffId: staff._id, acceptedAt: { $exists: false } }, { expiresAt: new Date() }, { session: opts.session });
  await Invite.create([{ phone: staff.phone, email: staff.email, roles, staffId: staff._id, tokenHash: sha256(token), expiresAt: hoursFromNow(INVITE_HOURS) }], { session: opts.session });
  await Staff.updateOne({ _id: staff._id }, { status: 'invited' }, { session: opts.session });
  await notify({
    schoolId,
    event: 'staff_invite',
    to: [{ phone: staff.phone, email: staff.email, name: fullName(staff), kind: 'staff' }],
    vars: { school: school.name, role: roleText, link: schoolLink(school.slug, `/portal/accept-invite?token=${token}`) }
  });
  return { token, existingUser: false };
}

// ------------------------------------------------------------------ guardians and students

export interface IssuedLogin {
  userId: string;
  login: string;
  temporaryPassword?: string;
  existingAccount: boolean;
}

async function createTempUser(fields: { firstName: string; lastName: string; phone?: string; email?: string }, session?: ClientSession) {
  const temp = randomPassword();
  const [user] = await User.create(
    [{ ...fields, passwordHash: await hashPassword(temp), mustChangePassword: true, tempPasswordExpiresAt: daysFromNow(TEMP_PASSWORD_DAYS) }],
    { session }
  );
  return { user, temp };
}

/**
 * Create or link the parent's account by phone number. One login covers all of a parent's children, even in different
 * schools. If the person already has an account the new membership appears under the same login and no password is sent.
 */
export async function ensureGuardianAccount(guardian: any, schoolId: string, session?: ClientSession): Promise<IssuedLogin> {
  let user = await User.findOne({ phone: guardian.phone }).session(session ?? null);
  let temp: string | undefined;
  const existingAccount = !!user;
  if (!user) {
    const made = await createTempUser({ firstName: guardian.firstName, lastName: guardian.lastName, phone: guardian.phone, email: guardian.email }, session);
    user = made.user;
    temp = made.temp;
  }
  await Membership.updateOne(
    { userId: user._id, schoolId, kind: 'guardian' },
    { $set: { guardianId: guardian._id, status: 'active', roles: [] }, $setOnInsert: { permVersion: 1, acceptedAt: new Date() } },
    { upsert: true, session }
  );
  await Guardian.updateOne({ _id: guardian._id }, { userId: user._id, lastInvitedAt: new Date() }, { session });
  return { userId: String(user._id), login: guardian.phone, temporaryPassword: temp, existingAccount };
}

/** A student account is optional and switched on per class level. The student signs in with their admission number. */
export async function ensureStudentAccount(student: any, schoolId: string, session?: ClientSession): Promise<IssuedLogin> {
  let user = student.userId ? await User.findById(student.userId).session(session ?? null) : null;
  let temp: string | undefined;
  const existingAccount = !!user;
  if (!user) {
    const made = await createTempUser({ firstName: student.firstName, lastName: student.lastName }, session);
    user = made.user;
    temp = made.temp;
    await Student.updateOne({ _id: student._id }, { userId: user._id }, { session });
  }
  await Membership.updateOne(
    { userId: user._id, schoolId, kind: 'student' },
    { $set: { studentId: student._id, status: 'active', roles: [] }, $setOnInsert: { permVersion: 1, acceptedAt: new Date() } },
    { upsert: true, session }
  );
  return { userId: String(user._id), login: student.admissionNumber, temporaryPassword: temp, existingAccount };
}

/** Rotate to a fresh temporary password (resend login). The old password stops working. */
export async function resetToTemporaryPassword(userId: string, session?: ClientSession): Promise<string> {
  const temp = randomPassword();
  await User.updateOne({ _id: userId }, { passwordHash: await hashPassword(temp), mustChangePassword: true, tempPasswordExpiresAt: daysFromNow(TEMP_PASSWORD_DAYS), failedLogins: 0, $unset: { lockedUntil: 1 } }, { session });
  return temp;
}

/**
 * Send login details for a student's family: the guardian gets their login, and the student gets theirs where the class
 * level has student login on. Returns what was sent. Nothing is sent to an adult who already has a password, other than a note that their new child appears under the same login.
 */
export async function sendFamilyLogins(opts: {
  school: { _id: unknown; name: string; slug: string };
  student: any;
  guardians: any[];
  studentLogin: boolean;
  resend?: boolean;
}): Promise<{ guardians: number; student: boolean }> {
  const schoolId = String(opts.school._id);
  const link = schoolLink(opts.school.slug, '/portal/login');
  const childName = fullName(opts.student);
  let sentGuardians = 0;
  let sentStudent = false;

  for (const g of opts.guardians) {
    const issued = await ensureGuardianAccount(g, schoolId);
    let temp = issued.temporaryPassword;
    if (!temp && opts.resend) temp = await resetToTemporaryPassword(issued.userId);
    if (temp) {
      await notify({
        schoolId,
        event: 'enrolled',
        to: [{ userId: issued.userId, phone: g.phone, email: g.email, name: fullName(g), kind: 'parent' }],
        vars: { child: childName, link, login: g.phone, password: temp }
      });
    } else {
      // Already has an account: the child appears under the same login.
      await notify({
        schoolId,
        event: 'application_status',
        to: [{ userId: issued.userId, phone: g.phone, email: g.email, kind: 'parent' }],
        vars: { child: childName, number: opts.student.admissionNumber, status: 'enrolled', note: 'Sign in with your existing login to see your child.' }
      });
    }
    sentGuardians += 1;
  }

  if (opts.studentLogin) {
    const issued = await ensureStudentAccount(opts.student, schoolId);
    let temp = issued.temporaryPassword;
    if (!temp && opts.resend) temp = await resetToTemporaryPassword(issued.userId);
    if (temp) {
      // The student has no phone. The temporary password goes to the main guardian, who hands it over.
      const main = opts.guardians[0];
      if (main) {
        await notify({
          schoolId,
          event: 'enrolled',
          to: [{ phone: main.phone, email: main.email, kind: 'parent' }],
          vars: { child: `${childName} (student login)`, link, login: opts.student.admissionNumber, password: temp }
        });
      }
      sentStudent = true;
    }
  }
  await audit({ action: 'accounts.logins.issued', entityType: 'student', entityId: opts.student._id, after: { guardians: sentGuardians, student: sentStudent } });
  return { guardians: sentGuardians, student: sentStudent };
}

/** The families of a set of students, with their main guardian first. */
export async function guardiansOfStudent(studentId: unknown) {
  const links = await StudentGuardian.find({ studentId, access: { $ne: 'none' } }).sort({ isPrimary: -1 }).lean();
  if (!links.length) return [];
  const gs = await Guardian.find({ _id: { $in: links.map((l) => l.guardianId) } }).lean();
  const byId = new Map(gs.map((g) => [String(g._id), g]));
  return links.map((l) => byId.get(String(l.guardianId))).filter(Boolean);
}

export const currentSchoolRef = async () => {
  const id = getCtx()?.schoolId;
  if (!id) throw validation('Choose a school first.');
  return School.findById(id).select('name slug').lean() as Promise<{ _id: unknown; name: string; slug: string }>;
};
