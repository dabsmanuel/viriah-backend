import type { Request } from 'express';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { env, isLocal } from '../config/env';
import { getCtx } from '../core/context';
import { audit } from '../core/audit';
import { AppError, forbidden, notFound, unauthenticated, validation } from '../core/errors';
import { Reply, me } from '../core/http';
import { accessCookie, ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_TTL_DAYS, refreshCookie, signAccess, SUPPORT_TTL_MIN, verifyAccess } from '../core/auth';
import { consume } from '../core/rateLimit';
import { permissionsForRoles } from '../core/permissions';
import { PLATFORM_ROLE_PERMS } from '../core/auth';
import { forSchool } from '../core/context';
import { hmac, randomDigits, randomPassword, randomToken, safeEqual, sha256 } from '../lib/crypto';
import { daysFromNow, minutesFromNow } from '../lib/dates';
import { maskPhone, normalizePhone } from '../lib/phone';
import { assertPasswordOk, checkPassword, dummyVerify, hashPassword } from '../lib/passwords';
import { sendSms } from '../integrations/sms';
import { sendEmail } from '../integrations/email';
import { publicUrl } from '../integrations/storage';
import { AuthSession, Guardian, Invite, Membership, Otp, School, Staff, Student, StudentGuardian, User } from '../models';
import { notify } from './notify';
import { asPlatform } from '../core/context';
import { DEFAULT_TEMPLATES, render } from '../templates/messages';
import type { HostInfo } from '../core/host';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const OTP_MINUTES = 10;
const OTP_ATTEMPTS = 5;

type UserDoc = any;

// ------------------------------------------------------------------ one-time codes

/** 6 digit codes, valid 10 minutes, 5 attempts, stored hashed. Requests are limited per phone number and per IP address. */
export async function createOtp(target: string, purpose: string, data?: Record<string, unknown>) {
  const code = randomDigits(6);
  await Otp.updateMany({ target, purpose, consumedAt: { $exists: false } }, { consumedAt: new Date() });
  const doc = await Otp.create({ target, purpose, codeHash: hmac(`${target}:${purpose}:${code}`), data, expiresAt: minutesFromNow(OTP_MINUTES) });
  return { code, id: String(doc._id) };
}

export async function verifyOtp(target: string, purpose: string, code: string): Promise<{ ok: boolean; data?: any; id?: string }> {
  const otp = await Otp.findOne({ target, purpose, consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!otp) return { ok: false };
  if (otp.attempts >= OTP_ATTEMPTS) return { ok: false };
  const good = safeEqual(otp.codeHash, hmac(`${target}:${purpose}:${code}`));
  if (!good) {
    await Otp.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    return { ok: false };
  }
  await Otp.updateOne({ _id: otp._id }, { consumedAt: new Date() });
  return { ok: true, data: otp.data, id: String(otp._id) };
}

export async function requireOtp(target: string, purpose: string, code: string) {
  const r = await verifyOtp(target, purpose, code);
  if (!r.ok) throw validation('That code is wrong or has expired. Ask for a new one.', { code: 'Wrong or expired code.' });
  return r.data;
}

/** Codes go through the transactional SMS route so they reach numbers with do-not-disturb on. */
export async function sendCode(target: { phone?: string; email?: string }, code: string) {
  const vars = { code };
  if (target.phone) {
    await sendSms(target.phone, render(DEFAULT_TEMPLATES.login_code.sms!, vars), 'transactional');
  } else if (target.email) {
    await sendEmail(target.email, render(DEFAULT_TEMPLATES.login_code.emailSubject!, vars), render(DEFAULT_TEMPLATES.login_code.email!, vars));
  }
}

/** Rate limits on code requests: per phone number and per IP. */
export async function limitCodeRequests(target: string, ip: string | undefined) {
  await consume(`code:target:${target}`, 60 * 60_000, 5);
  await consume(`code:ip:${ip ?? 'unknown'}`, 60 * 60_000, 30);
}

// ------------------------------------------------------------------ identify

export async function findUserByIdentifier(identifier: string, hostSchoolId?: string): Promise<UserDoc | null> {
  const id = identifier.trim();
  if (!id) return null;
  const select = '+passwordHash +twoFactor.secret +twoFactor.recoveryHashes';
  if (id.includes('@')) return User.findOne({ email: id.toLowerCase() }).select(select);
  const phone = normalizePhone(id);
  if (phone) {
    const u = await User.findOne({ phone }).select(select);
    if (u) return u;
  }
  if (hostSchoolId) {
    // Students sign in with their admission number on their school's address.
    const student = await forSchool(hostSchoolId, () => Student.findOne({ admissionNumber: id.toUpperCase() }).select('userId').lean());
    if (student?.userId) return User.findById(student.userId).select(select);
  }
  return null;
}

/** The phone that receives codes for an account. A student with no phone uses the main guardian's. */
export async function codePhoneFor(user: UserDoc, hostSchoolId?: string): Promise<string | undefined> {
  if (user.phone) return user.phone;
  const m = await Membership.findOne({ userId: user._id, kind: 'student', ...(hostSchoolId ? { schoolId: hostSchoolId } : {}) }).lean();
  if (!m?.studentId) return undefined;
  return forSchool(String(m.schoolId), async () => {
    const link = await StudentGuardian.findOne({ studentId: m.studentId }).sort({ isPrimary: -1 }).lean();
    if (!link) return undefined;
    return (await Guardian.findById(link.guardianId).select('phone').lean())?.phone;
  });
}

// ------------------------------------------------------------------ sessions and tokens

interface Issued {
  access: string;
  refresh?: string;
  sessionId: string;
}

export async function issueSession(user: UserDoc, membership: any | null, req: Request, opts: { support?: boolean; schoolId?: string } = {}): Promise<Issued> {
  const refresh = opts.support ? undefined : randomToken(32);
  const session = await AuthSession.create({
    userId: user._id,
    membershipId: membership?._id,
    schoolId: membership?.schoolId ?? opts.schoolId,
    refreshHash: refresh ? sha256(refresh) : randomToken(16),
    chainId: randomToken(12),
    userAgent: String(req.header('user-agent') ?? '').slice(0, 200),
    ip: req.ip,
    support: !!opts.support,
    expiresAt: opts.support ? minutesFromNow(SUPPORT_TTL_MIN) : daysFromNow(REFRESH_TTL_DAYS)
  });
  const roles = membership ? (membership.kind === 'guardian' ? ['parent'] : membership.kind === 'student' ? ['student'] : membership.roles) : opts.support ? ['owner'] : user.platformRole ? ['super_admin'] : [];
  const access = signAccess({
    sub: String(user._id),
    ses: String(session._id),
    mid: membership ? String(membership._id) : undefined,
    sid: membership ? String(membership.schoolId) : opts.schoolId,
    roles,
    pv: membership?.permVersion,
    sup: opts.support
  });
  return { access, refresh, sessionId: String(session._id) };
}

export function sessionReply(status: number, body: unknown, issued: Issued): Reply {
  const reply = new Reply(status, body);
  const cookies = [accessCookie(issued.access, !issued.refresh)];
  if (issued.refresh) cookies.push(refreshCookie(issued.refresh));
  return reply.withCookies(cookies);
}

export const clearSessionCookies = (reply: Reply) =>
  reply.withCookies(undefined, [{ name: ACCESS_COOKIE, options: { path: '/' } }, { name: REFRESH_COOKIE, options: { path: '/api/v1/auth' } }]);

const revokeChain = async (chainId: string) => AuthSession.updateMany({ chainId, revokedAt: { $exists: false } }, { revokedAt: new Date() });

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await AuthSession.updateMany({ userId, revokedAt: { $exists: false }, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) }, { revokedAt: new Date() });
}

// ------------------------------------------------------------------ views

const userView = (u: UserDoc) => ({ id: String(u._id), firstName: u.firstName, lastName: u.lastName, mustChangePassword: !!u.mustChangePassword, phone: u.phone, email: u.email, platformRole: u.platformRole });

async function membershipView(m: any) {
  const school = await School.findById(m.schoolId).select('name slug status branding').lean();
  return {
    id: String(m._id),
    schoolId: String(m.schoolId),
    school: school?.name,
    slug: school?.slug,
    schoolStatus: school?.status,
    logo: publicUrl(school?.branding?.logo),
    kind: m.kind,
    roles: m.kind === 'guardian' ? ['parent'] : m.kind === 'student' ? ['student'] : m.roles
  };
}

// ------------------------------------------------------------------ login

export interface LoginInput {
  identifier: string;
  password: string;
}

export async function login(input: LoginInput, req: Request): Promise<Reply> {
  const host: HostInfo | undefined = (req as any).hostInfo;
  const hostSchoolId = host?.kind === 'school' ? host.schoolId : undefined;
  await consume(`login:id:${input.identifier.toLowerCase()}`, 15 * 60_000, 20);

  const user = await findUserByIdentifier(input.identifier, hostSchoolId);
  if (!user) {
    await dummyVerify(input.password);
    throw unauthenticated('The login or password is wrong.');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new AppError('rate_limited', `This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}. Try again later, or reset your password.`, { retryAfter: mins * 60 });
  }
  const good = await checkPassword(user.passwordHash, input.password);
  if (!good) {
    await recordFailedLogin(user);
    throw unauthenticated('The login or password is wrong.');
  }
  if (user.status !== 'active') throw unauthenticated('This account is not active. Ask the school to help.');
  await User.updateOne({ _id: user._id }, { failedLogins: 0, $unset: { lockedUntil: 1 } });

  // ---- two-step login: required for the super admin, optional for others
  const needsTwoStep = user.platformRole === 'super_admin' || !!user.twoFactor?.type;
  if (needsTwoStep) return startTwoStep(user, hostSchoolId, req);

  return completeLogin(user, host, req);
}

async function recordFailedLogin(user: UserDoc) {
  const failed = (user.failedLogins ?? 0) + 1;
  if (failed >= MAX_FAILED) {
    const log = [...(user.lockoutLog ?? []), new Date()].slice(-10);
    await User.updateOne({ _id: user._id }, { failedLogins: 0, lockedUntil: minutesFromNow(LOCK_MINUTES), lockoutLog: log });
    await audit({ action: 'auth.lockout', entityType: 'user', entityId: user._id, actorUserId: String(user._id) });
    // Repeated lockouts alert the school admin.
    const recent = log.filter((d: Date) => Date.now() - d.getTime() < 24 * 3600_000).length;
    if (recent >= 3) {
      const memberships = await Membership.find({ userId: user._id, status: 'active' }).select('schoolId').lean();
      for (const m of memberships) {
        const admins = await Membership.find({ schoolId: m.schoolId, kind: 'staff', roles: { $in: ['school_admin', 'owner'] }, status: 'active' }).select('userId').lean();
        await notify({
          schoolId: String(m.schoolId),
          event: 'approval_event',
          to: admins.map((a) => ({ userId: String(a.userId), kind: 'admin' as const })),
          vars: { title: 'Repeated sign-in lockouts', body: `${user.firstName ?? 'A user'} ${user.lastName ?? ''} was locked out of their account several times today. They may need help.` }
        });
      }
    }
  } else {
    await User.updateOne({ _id: user._id }, { failedLogins: failed });
  }
}

async function startTwoStep(user: UserDoc, hostSchoolId: string | undefined, req: Request): Promise<Reply> {
  const method: 'totp' | 'sms' = user.twoFactor?.type === 'totp' && user.twoFactor?.secret ? 'totp' : 'sms';
  const target = String(user._id);
  let challenge;
  if (method === 'sms') {
    const phone = await codePhoneFor(user, hostSchoolId);
    if (!phone) throw new AppError('forbidden', 'This account has no phone number for a login code. Ask the school admin to add one.');
    await limitCodeRequests(phone, req.ip);
    const { code, id } = await createOtp(target, 'login_2fa', { hostSchoolId, phone });
    await sendCode({ phone }, code);
    challenge = id;
  } else {
    const { id } = await createOtp(target, 'login_2fa', { hostSchoolId, totp: true });
    challenge = id;
  }
  return new Reply(200, { data: { next: 'two_step', challengeId: challenge, method, ...(method === 'sms' ? { sentTo: maskPhone((await Otp.findById(challenge))?.data?.phone ?? '') } : {}) } });
}

export async function completeTwoStep(input: { challengeId: string; code: string }, req: Request): Promise<Reply> {
  const otp = await Otp.findOne({ _id: input.challengeId, purpose: 'login_2fa', consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
  if (!otp) throw unauthenticated('This sign-in has expired. Start again.');
  if (otp.attempts >= OTP_ATTEMPTS) throw new AppError('rate_limited', 'Too many wrong codes. Start the sign-in again.', { retryAfter: 600 });
  const user = await User.findById(otp.target).select('+twoFactor.secret +twoFactor.recoveryHashes +passwordHash');
  if (!user || user.status !== 'active') throw unauthenticated();

  let valid = false;
  const code = input.code.trim();
  if (otp.data?.totp) {
    if (/^\d{6}$/.test(code)) valid = verifySync({ secret: user.twoFactor!.secret!, token: code, epochTolerance: 30 }).valid;
  } else {
    valid = safeEqual(otp.codeHash, hmac(`${otp.target}:login_2fa:${code}`));
  }
  // Recovery code (one use)
  if (!valid) {
    const h = sha256(code.toUpperCase());
    const idx = (user.twoFactor?.recoveryHashes ?? []).indexOf(h);
    if (idx >= 0) {
      valid = true;
      const rest = [...user.twoFactor!.recoveryHashes!];
      rest.splice(idx, 1);
      await User.updateOne({ _id: user._id }, { 'twoFactor.recoveryHashes': rest });
    }
  }
  if (!valid) {
    await Otp.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    throw unauthenticated('That code is wrong.');
  }
  await Otp.updateOne({ _id: otp._id }, { consumedAt: new Date() });
  const host: HostInfo | undefined = (req as any).hostInfo;
  return completeLogin(user, host, req, otp.data?.hostSchoolId);
}

/** After the password (and two-step code) are right: pick the membership and issue the session. */
async function completeLogin(user: UserDoc, host: HostInfo | undefined, req: Request, hostSchoolIdOverride?: string): Promise<Reply> {
  const hostSchoolId = hostSchoolIdOverride ?? (host?.kind === 'school' ? host.schoolId : undefined);
  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });

  const memberships = await Membership.find({ userId: user._id, status: 'active', ...(hostSchoolId ? { schoolId: hostSchoolId } : {}) }).sort({ createdAt: 1 }).lean();

  // Super admin and platform staff sign in to the console on the admin host (or with no school host).
  if (user.platformRole && !hostSchoolId) {
    const issued = await issueSession(user, null, req);
    await audit({ action: 'auth.login', entityType: 'user', entityId: user._id, actorUserId: String(user._id), after: { platform: true } });
    return sessionReply(200, { data: { next: user.mustChangePassword ? 'change_password' : 'home', portal: 'admin', user: userView(user), membership: null } }, issued);
  }

  if (!memberships.length) {
    if (hostSchoolId) throw unauthenticated('There is no account for you at this school.');
    throw unauthenticated('There is no school account for this login yet.');
  }

  if (memberships.length === 1) {
    const m = memberships[0];
    const issued = await issueSession(user, m, req);
    await audit({ action: 'auth.login', entityType: 'user', entityId: user._id, actorUserId: String(user._id), schoolId: String(m.schoolId) });
    return sessionReply(200, { data: { next: user.mustChangePassword ? 'change_password' : 'home', user: userView(user), membership: await membershipView(m), ...(isLocal && req.header('x-return-tokens') ? { tokens: { access: issued.access, refresh: issued.refresh } } : {}) } }, issued);
  }

  // More than one role or school: the user chooses. The session has no membership until they do.
  const issued = await issueSession(user, null, req);
  await audit({ action: 'auth.login', entityType: 'user', entityId: user._id, actorUserId: String(user._id), after: { chooser: true } });
  const list = await Promise.all(memberships.map(membershipView));
  return sessionReply(200, { data: { next: user.mustChangePassword ? 'change_password' : 'choose_membership', user: userView(user), memberships: list } }, issued);
}

// ------------------------------------------------------------------ refresh, logout

export async function refresh(req: Request): Promise<Reply> {
  const token = (req as any).cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
  if (!token) throw unauthenticated();
  const hash = sha256(token);
  const session = await AuthSession.findOne({ refreshHash: hash });
  if (!session) {
    // Reuse of an old token revokes the whole chain.
    const reused = await AuthSession.findOne({ previousHashes: hash });
    if (reused) {
      await revokeChain(reused.chainId);
      await audit({ action: 'auth.refresh_reuse', entityType: 'user', entityId: reused.userId, actorUserId: String(reused.userId) });
    }
    throw unauthenticated('Your session has ended. Sign in again.');
  }
  if (session.revokedAt || session.expiresAt < new Date() || session.support) throw unauthenticated('Your session has ended. Sign in again.');

  const user = await User.findById(session.userId).select('firstName lastName status platformRole mustChangePassword').lean();
  if (!user || user.status !== 'active') {
    await revokeChain(session.chainId);
    throw unauthenticated();
  }
  let membership: any = null;
  if (session.membershipId) {
    membership = await Membership.findById(session.membershipId).lean();
    if (!membership || membership.status !== 'active') {
      await revokeChain(session.chainId);
      throw unauthenticated('Your access to this school has ended.');
    }
  }
  const newRefresh = randomToken(32);
  await AuthSession.updateOne(
    { _id: session._id },
    { refreshHash: sha256(newRefresh), $push: { previousHashes: { $each: [hash], $slice: -10 } }, lastUsedAt: new Date(), expiresAt: daysFromNow(REFRESH_TTL_DAYS) }
  );
  const roles = membership ? (membership.kind === 'guardian' ? ['parent'] : membership.kind === 'student' ? ['student'] : membership.roles) : user.platformRole ? ['super_admin'] : [];
  const access = signAccess({ sub: String(user._id), ses: String(session._id), mid: membership ? String(membership._id) : undefined, sid: membership ? String(membership.schoolId) : undefined, roles, pv: membership?.permVersion });
  return sessionReply(200, { data: { ok: true } }, { access, refresh: newRefresh, sessionId: String(session._id) });
}

export async function logout(): Promise<Reply> {
  const c = me();
  if (c.sessionId) await AuthSession.updateOne({ _id: c.sessionId }, { revokedAt: new Date() });
  return clearSessionCookies(new Reply(204));
}

export async function logoutAll(): Promise<Reply> {
  const c = me();
  await revokeAllSessions(c.userId);
  await audit({ action: 'auth.logout_all', entityType: 'user', entityId: c.userId });
  return clearSessionCookies(new Reply(204));
}

// ------------------------------------------------------------------ passwords

export async function forgotPassword(identifier: string, req: Request) {
  const host: HostInfo | undefined = (req as any).hostInfo;
  const hostSchoolId = host?.kind === 'school' ? host.schoolId : undefined;
  await consume(`forgot:id:${identifier.toLowerCase()}`, 60 * 60_000, 5);
  const user = await findUserByIdentifier(identifier, hostSchoolId);
  // The answer never reveals whether the account exists.
  if (!user || user.status !== 'active') return;
  const phone = await codePhoneFor(user, hostSchoolId);
  if (phone) {
    await limitCodeRequests(phone, req.ip);
    const { code } = await createOtp(String(user._id), 'password_reset');
    await sendCode({ phone }, code);
  } else if (user.email) {
    await limitCodeRequests(user.email, req.ip);
    const token = randomToken(24);
    const code = randomDigits(6);
    await Otp.create({ target: String(user._id), purpose: 'password_reset_link', codeHash: sha256(token), data: { code }, expiresAt: minutesFromNow(60) });
    await sendEmail(user.email, 'Reset your password', `Open this link to set a new password: ${env.WEB_ORIGIN}/portal/reset-password?token=${token}\nThe link works for one hour.`);
  }
}

export async function resetPassword(input: { identifier?: string; code?: string; token?: string; newPassword: string }, req: Request): Promise<void> {
  const host: HostInfo | undefined = (req as any).hostInfo;
  const hostSchoolId = host?.kind === 'school' ? host.schoolId : undefined;
  let userId: string | undefined;

  if (input.token) {
    const otp = await Otp.findOne({ purpose: 'password_reset_link', codeHash: sha256(input.token), consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
    if (!otp) throw validation('This link is wrong or has expired. Ask for a new one.');
    await Otp.updateOne({ _id: otp._id }, { consumedAt: new Date() });
    userId = otp.target;
  } else {
    if (!input.identifier || !input.code) throw validation('Enter your login and the 6 digit code.');
    await consume(`reset:id:${input.identifier.toLowerCase()}`, 15 * 60_000, 10);
    const user = await findUserByIdentifier(input.identifier, hostSchoolId);
    if (!user) throw validation('That code is wrong or has expired. Ask for a new one.', { code: 'Wrong or expired code.' });
    await requireOtp(String(user._id), 'password_reset', input.code);
    userId = String(user._id);
  }

  const user = await User.findById(userId).select('+passwordHash');
  if (!user || user.status !== 'active') throw validation('This account cannot be reset.');
  assertPasswordOk(input.newPassword, [user.phone, user.firstName, user.lastName]);
  await User.updateOne({ _id: user._id }, { passwordHash: await hashPassword(input.newPassword), mustChangePassword: false, failedLogins: 0, $unset: { lockedUntil: 1, tempPasswordExpiresAt: 1 } });
  await revokeAllSessions(String(user._id)); // all other sessions are ended
  await audit({ action: 'auth.password.reset', entityType: 'user', entityId: user._id, actorUserId: String(user._id) });
  await notifyPasswordChanged(user);
}

async function notifyPasswordChanged(user: UserDoc) {
  const ms = await Membership.find({ userId: user._id, status: 'active' }).select('schoolId').lean();
  if (!ms.length) {
    if (user.email) await sendEmail(user.email, 'Your password changed', render(DEFAULT_TEMPLATES.password_changed.email!, {}));
    return;
  }
  for (const m of ms) await notify({ schoolId: String(m.schoolId), event: 'password_changed', to: [{ userId: String(user._id), email: user.email, kind: 'user' }] });
}

export async function changePassword(input: { currentPassword: string; newPassword: string }): Promise<Reply> {
  const c = me();
  const user = await User.findById(c.userId).select('+passwordHash firstName lastName phone');
  if (!user) throw unauthenticated();
  if (!(await checkPassword(user.passwordHash, input.currentPassword))) throw validation('The current password is wrong.', { currentPassword: 'Wrong password.' });
  if (input.currentPassword === input.newPassword) throw validation('Choose a password you have not used just now.', { newPassword: 'Choose a different password.' });
  assertPasswordOk(input.newPassword, [user.phone, user.firstName, user.lastName]);
  await User.updateOne({ _id: user._id }, { passwordHash: await hashPassword(input.newPassword), mustChangePassword: false, $unset: { tempPasswordExpiresAt: 1 } });
  await revokeAllSessions(c.userId, c.sessionId); // other sessions end, this one stays
  await AuthSession.updateOne({ _id: c.sessionId }, { lastConfirmedAt: new Date() });
  await audit({ action: 'auth.password.change', entityType: 'user', entityId: user._id });
  await notifyPasswordChanged(user);
  return new Reply(200, { data: { ok: true } });
}

export async function confirmPassword(password: string) {
  const c = me();
  const user = await User.findById(c.userId).select('+passwordHash');
  if (!user || !(await checkPassword(user.passwordHash, password))) throw validation('The password is wrong.', { password: 'Wrong password.' });
  await AuthSession.updateOne({ _id: c.sessionId }, { lastConfirmedAt: new Date() });
}

/** A school admin resets a staff, parent or student password. The person gets a code or a temporary password by SMS. Every reset is logged. */
export async function adminResetPassword(userId: string, reason?: string) {
  const user = await User.findById(userId).select('+passwordHash phone firstName lastName email');
  if (!user) throw notFound('User');
  const temp = randomPassword();
  await User.updateOne({ _id: user._id }, { passwordHash: await hashPassword(temp), mustChangePassword: true, tempPasswordExpiresAt: daysFromNow(14), failedLogins: 0, $unset: { lockedUntil: 1 } });
  await revokeAllSessions(String(user._id));
  await audit({ action: 'auth.password.admin_reset', entityType: 'user', entityId: user._id, reason });
  return { temp, user };
}

// ------------------------------------------------------------------ invites

export async function acceptInvite(input: { token: string; password: string }, req: Request): Promise<Reply> {
  const invite = await asPlatform(() => Invite.findOne({ tokenHash: sha256(input.token), acceptedAt: { $exists: false }, expiresAt: { $gt: new Date() } }));
  if (!invite) throw validation('This invite link is wrong or has expired. Ask the school to send it again.', { token: 'Invalid or expired.' });
  const schoolId = String(invite.schoolId);

  const out = await forSchool(schoolId, async () => {
    const staff = await Staff.findById(invite.staffId);
    if (!staff) throw notFound('Staff member');
    assertPasswordOk(input.password, [staff.phone, staff.firstName, staff.lastName]);
    let user = await User.findOne({ phone: staff.phone }).select('+passwordHash');
    if (!user) {
      user = await User.create({ firstName: staff.firstName, lastName: staff.lastName, phone: staff.phone, email: staff.email, passwordHash: await hashPassword(input.password), phoneVerifiedAt: new Date() });
    }
    const membership = await Membership.findOneAndUpdate(
      { userId: user._id, schoolId, kind: 'staff' },
      { $set: { roles: staff.roles, status: 'active', staffId: staff._id, acceptedAt: new Date() }, $setOnInsert: { permVersion: 1 } },
      { upsert: true, new: true }
    );
    await Staff.updateOne({ _id: staff._id }, { userId: user._id, status: 'active' });
    await Invite.updateOne({ _id: invite._id }, { acceptedAt: new Date() });
    await audit({ action: 'staff.invite.accepted', entityType: 'staff', entityId: staff._id, actorUserId: String(user._id), schoolId });
    return { user, membership };
  });

  const issued = await issueSession(out.user, out.membership, req);
  return sessionReply(200, { data: { next: 'home', user: userView(out.user), membership: await membershipView(out.membership) } }, issued);
}

// ------------------------------------------------------------------ me, switch, sessions

export async function currentUser(req: Request) {
  const c = me();
  const user = await User.findById(c.userId).select('firstName lastName phone email platformRole mustChangePassword twoFactor.type twoFactor.enabledAt').lean();
  if (!user) throw unauthenticated();
  const memberships = await Membership.find({ userId: c.userId, status: 'active' }).sort({ createdAt: 1 }).lean();
  const current = c.membershipId ? memberships.find((m) => String(m._id) === c.membershipId) : undefined;
  let school: any = null;
  if (c.schoolId) {
    const s = await School.findById(c.schoolId).select('name slug status branding motto settings.showFeesToStudents').lean();
    if (s) {
      school = { id: String(s._id), name: s.name, slug: s.slug, status: s.status, motto: s.motto, branding: { ...s.branding, logo: publicUrl(s.branding?.logo) }, showFeesToStudents: !!(s as any).settings?.showFeesToStudents };
    }
  }
  // A platform user (super admin, platform staff) signed in to the console has no school. Say so, with the console's permissions,
  // so the console can tell a signed-in admin from a signed-out visitor.
  const platformSession = !c.membershipId && !c.support && !!user.platformRole;
  const platformRoles = platformSession ? [user.platformRole === 'super_admin' ? 'super_admin' : `platform_${user.platformRole}`] : [];
  const platformPerms = platformSession ? new Set<string>([...(user.platformRole === 'super_admin' ? permissionsForRoles(['super_admin']) : PLATFORM_ROLE_PERMS[user.platformRole as string] ?? []), 'notifications.own', 'dashboard.view']) : null;
  const memberships_ = c.support ? [] : await Promise.all(memberships.map(membershipView));
  return {
    user: { ...userView(user), twoFactor: user.twoFactor?.type ?? null },
    memberships: memberships_,
    current: c.kind === 'platform' || platformSession ? { kind: 'platform', roles: platformSession ? platformRoles : c.roles } : current ? await membershipView(current) : c.support ? { kind: 'staff', roles: ['owner'], schoolId: c.schoolId } : null,
    school,
    permissions: [...(platformPerms ?? c.permissions)].sort(),
    support: !!c.support,
    ids: { staffId: c.staffId, guardianId: c.guardianId, studentId: c.studentId }
  };
}

export async function switchMembership(membershipId: string, req: Request): Promise<Reply> {
  const c = me();
  const user = await User.findById(c.userId).lean();
  if (!user || user.status !== 'active') throw unauthenticated();
  const membership = await Membership.findOne({ _id: membershipId, userId: c.userId, status: 'active' }).lean();
  if (!membership) throw notFound('Membership');
  const host: HostInfo | undefined = (req as any).hostInfo;
  // Session cookies are tied to one school's address: switching to another school happens on that school's address.
  if (host?.kind === 'school' && host.schoolId !== String(membership.schoolId)) throw forbidden('Open that school at its own address to switch to it.');
  if (c.sessionId) await AuthSession.updateOne({ _id: c.sessionId }, { revokedAt: new Date() });
  const issued = await issueSession(user, membership, req);
  await audit({ action: 'auth.switch', entityType: 'membership', entityId: membership._id, schoolId: String(membership.schoolId), actorUserId: c.userId });
  return sessionReply(200, { data: { membership: await membershipView(membership) } }, issued);
}

export async function listSessions() {
  const c = me();
  const rows = await AuthSession.find({ userId: c.userId, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() }, support: false }).sort({ lastUsedAt: -1 }).lean();
  return rows.map((s) => ({ id: String(s._id), userAgent: s.userAgent, ip: s.ip, lastUsedAt: s.lastUsedAt, createdAt: s.createdAt, current: String(s._id) === c.sessionId }));
}

export async function endSession(id: string) {
  const c = me();
  const r = await AuthSession.updateOne({ _id: id, userId: c.userId }, { revokedAt: new Date() });
  if (!r.matchedCount) throw notFound('Session');
}

// ------------------------------------------------------------------ two-step setup

export async function twoStepSetup(method: 'totp' | 'sms') {
  const c = me();
  const user = await User.findById(c.userId).select('phone email firstName lastName');
  if (!user) throw unauthenticated();
  if (method === 'sms') {
    const phone = user.phone;
    if (!phone) throw validation('Add a phone number to your account first.');
    const { code } = await createOtp(String(user._id), 'two_step_setup', { method });
    await sendCode({ phone }, code);
    return { method, sentTo: maskPhone(phone) };
  }
  const secret = generateSecret();
  await User.updateOne({ _id: user._id }, { 'twoFactor.pendingSecret': secret });
  const uri = generateURI({ issuer: 'Viriah', label: user.phone ?? user.email ?? String(user._id), secret });
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return { method, secret, otpauthUrl: uri, qr };
}

export async function twoStepConfirm(code: string) {
  const c = me();
  const user = await User.findById(c.userId).select('+twoFactor.pendingSecret');
  if (!user) throw unauthenticated();
  let type: 'totp' | 'sms';
  let secret: string | undefined;
  if (user.twoFactor?.pendingSecret) {
    if (!verifySync({ secret: user.twoFactor.pendingSecret, token: code, epochTolerance: 30 }).valid) throw validation('That code is wrong.', { code: 'Wrong code.' });
    type = 'totp';
    secret = user.twoFactor.pendingSecret;
  } else {
    await requireOtp(String(user._id), 'two_step_setup', code);
    type = 'sms';
  }
  const recovery = Array.from({ length: 8 }, () => `${randomToken(4).replace(/[-_]/g, 'A').slice(0, 5).toUpperCase()}-${randomToken(4).replace(/[-_]/g, 'B').slice(0, 5).toUpperCase()}`);
  await User.updateOne(
    { _id: user._id },
    { 'twoFactor.type': type, 'twoFactor.secret': secret, 'twoFactor.recoveryHashes': recovery.map((r) => sha256(r.toUpperCase())), 'twoFactor.enabledAt': new Date(), $unset: { 'twoFactor.pendingSecret': 1 } }
  );
  await audit({ action: 'auth.two_step.enable', entityType: 'user', entityId: user._id, after: { type } });
  return { recoveryCodes: recovery };
}

export async function twoStepDisable() {
  const c = me();
  const user = await User.findById(c.userId).select('platformRole');
  if (user?.platformRole === 'super_admin') throw forbidden('Two-step login cannot be switched off for the super admin.');
  await User.updateOne({ _id: c.userId }, { $unset: { 'twoFactor.type': 1, 'twoFactor.secret': 1, 'twoFactor.pendingSecret': 1, 'twoFactor.recoveryHashes': 1, 'twoFactor.enabledAt': 1 } });
  await audit({ action: 'auth.two_step.disable', entityType: 'user', entityId: c.userId });
}

// ------------------------------------------------------------------ support session

/** The super admin hands a support token to the school's address. It is exchanged there for a cookie that lasts 60 minutes. */
export async function exchangeSupportToken(token: string, req: Request): Promise<Reply> {
  const claims = verifyAccess(token);
  if (!claims.sup || !claims.sid) throw unauthenticated();
  const session = await AuthSession.findById(claims.ses).lean();
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw unauthenticated('This support session has ended.');
  const host: HostInfo | undefined = (req as any).hostInfo;
  if (host?.kind === 'school' && host.schoolId !== claims.sid) throw forbidden();
  return sessionReply(200, { data: { ok: true, schoolId: claims.sid, expiresAt: session.expiresAt } }, { access: token, refresh: undefined, sessionId: claims.ses });
}

export async function startSupportSession(schoolId: string, reason: string, req: Request) {
  const c = me();
  const user = await User.findById(c.userId).lean();
  const school = await School.findById(schoolId).select('name slug status').lean();
  if (!school) throw notFound('School');
  if (!user?.platformRole) throw forbidden();
  const issued = await issueSession(user, null, req, { support: true, schoolId });
  await audit({ action: 'platform.support.start', entityType: 'school', entityId: schoolId, schoolId, reason });
  return { supportToken: issued.access, sessionId: issued.sessionId, expiresAt: minutesFromNow(SUPPORT_TTL_MIN), school: { id: schoolId, name: school.name, slug: school.slug } };
}

export async function endSupportSession() {
  const c = me();
  if (!c.sessionId) return;
  // A support session is ended from the console with the super admin's own session.
  const sessions = await AuthSession.find({ userId: c.userId, support: true, revokedAt: { $exists: false } }).select('_id schoolId').lean();
  await AuthSession.updateMany({ userId: c.userId, support: true, revokedAt: { $exists: false } }, { revokedAt: new Date() });
  for (const s of sessions) await audit({ action: 'platform.support.end', entityType: 'school', entityId: s.schoolId, schoolId: s.schoolId ? String(s.schoolId) : undefined });
}

export const permissionsFor = (roles: string[], extras: string[] = []) => permissionsForRoles(roles, extras);
export { getCtx };
