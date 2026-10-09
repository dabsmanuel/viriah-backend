import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { audit } from '../core/audit';
import { asPlatform, forSchool, getCtx } from '../core/context';
import { tx } from '../core/db';
import { AppError, duplicate, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { me } from '../core/http';
import { RESERVED_SLUGS } from '../core/host';
import { consume } from '../core/rateLimit';
import { escapeRegex, paging, searchRegex } from '../core/pagination';
import { hmac, randomDigits, randomToken, sha256 } from '../lib/crypto';
import { minutesFromNow } from '../lib/dates';
import { normalizePhone } from '../lib/phone';
import { assertPasswordOk, checkPassword, hashPassword } from '../lib/passwords';
import { schoolLink, portalLink } from '../lib/links';
import { sendEmail } from '../integrations/email';
import { publicUrl } from '../integrations/storage';
import { AuditLog, AuthSession, Guardian, Job, Membership, Payment, School, Site, Staff, Student, Term, User, Otp, WebhookEvent } from '../models';
import { Reply } from '../core/http';
import { notify } from './notify';
import { createOtp, limitCodeRequests, requireOtp, sendCode } from './auth';
import { inviteStaffMember } from './accounts';
import { need, platformSettings, ownerRecipients } from './common';
import { computeSetupProgress } from './setup';

const SIGNUP_TTL_MIN = 30;

// ------------------------------------------------------------------ web address

const SLUG_RE = /^[a-z][a-z0-9-]{2,39}$/;

export async function reservedSlugs(): Promise<string[]> {
  const s = await platformSettings();
  return [...new Set([...RESERVED_SLUGS, ...(s.reservedSlugs ?? [])])];
}

export interface SlugCheck {
  slug: string;
  available: boolean;
  reason?: 'invalid' | 'reserved' | 'taken';
  suggestions: string[];
}

/** The address is checked for availability as the owner types: unique, not reserved, 3 to 40 characters. */
export async function checkSlug(raw: string, hint?: { town?: string }): Promise<SlugCheck> {
  const slug = raw.trim().toLowerCase();
  const out: SlugCheck = { slug, available: false, suggestions: [] };
  if (!SLUG_RE.test(slug)) return { ...out, reason: 'invalid' };
  if ((await reservedSlugs()).includes(slug)) return { ...out, reason: 'reserved', suggestions: await suggest(slug, hint?.town) };
  if (await School.exists({ slug })) return { ...out, reason: 'taken', suggestions: await suggest(slug, hint?.town) };
  return { ...out, available: true };
}

async function suggest(base: string, town?: string): Promise<string[]> {
  const t = town?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const candidates = [t ? `${base}-${t}` : '', `${base}-school`, `${base}-academy`, `${base}-2`, `${base}-${new Date().getFullYear()}`, `${base}-ng`].filter((c) => SLUG_RE.test(c) && c.length <= 40);
  const taken = new Set((await School.find({ slug: { $in: candidates } }).select('slug').lean()).map((s: any) => s.slug));
  const reserved = new Set(await reservedSlugs());
  return candidates.filter((c) => !taken.has(c) && !reserved.has(c)).slice(0, 4);
}

// ------------------------------------------------------------------ public sign-up (ONB-01, ONB-02)

/** The owner's phone is verified by SMS code and the email by link before the sign-up is submitted. */
export async function registerStart(input: { phone: string; email: string }, req: Request) {
  await limitCodeRequests(input.phone, req.ip);
  await limitCodeRequests(input.email, req.ip);
  const { code } = await createOtp(input.phone, 'signup_phone');
  await sendCode({ phone: input.phone }, code);
  const token = randomToken(24);
  await Otp.create({ target: input.email, purpose: 'signup_email', codeHash: sha256(token), expiresAt: minutesFromNow(60) });
  await sendEmail(input.email, 'Confirm your email address', `Confirm your email address for your school sign-up: ${env.WEB_ORIGIN}/register/confirm-email?token=${token}&email=${encodeURIComponent(input.email)}\nThe link works for one hour.`);
}

export async function registerVerify(input: { phone: string; code: string; email: string; emailToken: string }) {
  await consume(`signup:verify:${input.phone}`, 15 * 60_000, 10);
  await requireOtp(input.phone, 'signup_phone', input.code);
  const emailOtp = await Otp.findOne({ target: input.email, purpose: 'signup_email', codeHash: sha256(input.emailToken), consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
  if (!emailOtp) throw validation('The email link is wrong or has expired. Ask for a new one.', { emailToken: 'Wrong or expired.' });
  await Otp.updateOne({ _id: emailOtp._id }, { consumedAt: new Date() });
  const signupToken = jwt.sign({ typ: 'signup', phone: input.phone, email: input.email }, env.JWT_ACCESS_SECRET, { expiresIn: `${SIGNUP_TTL_MIN}m` });
  return { signupToken, expiresInMinutes: SIGNUP_TTL_MIN };
}

export interface RegisterInput {
  signupToken: string;
  school: { name: string; types: string[]; address: { street?: string; town?: string; lga: string; state: string }; registrationNumber?: string; phone?: string; email?: string };
  slug: string;
  owner: { firstName: string; lastName: string; password: string };
  acceptTerms: true;
  acceptDpa: true;
}

export async function registerSchool(input: RegisterInput) {
  let claims: { typ: string; phone: string; email: string };
  try {
    claims = jwt.verify(input.signupToken, env.JWT_ACCESS_SECRET) as typeof claims;
    if (claims.typ !== 'signup') throw new Error();
  } catch {
    throw validation('Your sign-up check has expired. Verify your phone and email again.', { signupToken: 'Expired.' });
  }

  const check = await checkSlug(input.slug, { town: input.school.address.town });
  if (!check.available) {
    throw new AppError('duplicate', check.reason === 'invalid' ? 'Use 3 to 40 lowercase letters, digits or hyphens, starting with a letter.' : 'That web address is not available. Try one of the suggestions.', {
      fields: { slug: check.reason === 'reserved' ? 'Reserved.' : check.reason === 'taken' ? 'Already taken.' : 'Not valid.' },
      details: { suggestions: check.suggestions }
    });
  }

  assertPasswordOk(input.owner.password, [claims.phone, input.owner.firstName, input.owner.lastName]);

  // A school with the same name in the same LGA is allowed but flagged to the super admin as a possible duplicate.
  const possibleDuplicate = !!(await School.exists({ name: new RegExp(`^${escapeRegex(input.school.name.trim())}$`, 'i'), 'address.lga': input.school.address.lga }));

  // An existing account (for example a parent who now opens a school) must prove ownership with its password.
  let user = await User.findOne({ phone: claims.phone }).select('+passwordHash');
  if (user && !(await checkPassword(user.passwordHash, input.owner.password))) {
    throw duplicate('This phone number already has an account. Use that account’s password here.', { field: 'password' });
  }
  const emailOwner = await User.findOne({ email: claims.email }).select('_id').lean();
  if (emailOwner && (!user || String(emailOwner._id) !== String(user._id))) throw duplicate('This email address is already used by another account.', { field: 'email' });

  const result = await tx(async (session) => {
    if (!user) {
      [user] = await User.create(
        [{ firstName: input.owner.firstName, lastName: input.owner.lastName, phone: claims.phone, email: claims.email, passwordHash: await hashPassword(input.owner.password), phoneVerifiedAt: new Date(), emailVerifiedAt: new Date() }],
        { session }
      );
    }
    const [school] = await School.create(
      [
        {
          name: input.school.name.trim(),
          slug: input.slug.toLowerCase(),
          types: input.school.types,
          address: input.school.address,
          phone: input.school.phone ?? claims.phone,
          email: input.school.email ?? claims.email,
          registrationNumber: input.school.registrationNumber,
          status: 'pending',
          statusHistory: [{ status: 'pending', at: new Date(), by: user._id }],
          ownerUserId: user._id,
          possibleDuplicate,
          termsAcceptedAt: new Date(),
          dpaAcceptedAt: new Date(),
          settings: { receiptPrefix: makePrefix(input.school.name) }
        }
      ],
      { session }
    );
    await forSchool(String(school._id), async () => {
      const [staff] = await Staff.create([{ userId: user._id, firstName: user.firstName, lastName: user.lastName, phone: claims.phone, email: claims.email, roles: ['owner'], status: 'active' }], { session });
      await Membership.create([{ userId: user._id, schoolId: school._id, kind: 'staff', roles: ['owner'], staffId: staff._id, status: 'active', acceptedAt: new Date() }], { session });
    });
    return { school, user };
  });

  await audit({ action: 'school.registered', entityType: 'school', entityId: result.school._id, schoolId: String(result.school._id), actorUserId: String(result.user._id), after: { name: result.school.name, slug: result.school.slug, possibleDuplicate } });
  await notify({ schoolId: String(result.school._id), event: 'signup_received', to: [{ userId: String(result.user._id), phone: claims.phone, email: claims.email, kind: 'owner' }], vars: { school: result.school.name } });
  // The super admin is told by email.
  await sendEmail(env.SUPER_ADMIN_EMAIL, `New school sign-up: ${result.school.name}`, `${result.school.name} (${result.school.slug}) signed up and is waiting for approval.${possibleDuplicate ? ' It may duplicate an existing school.' : ''}`);

  return { school: { id: String(result.school._id), name: result.school.name, slug: result.school.slug, status: result.school.status }, loginUrl: portalLink(result.school.slug, '/login') };
}

/** A short receipt prefix from the school name: "Greenfield Schools" gives GFS. */
export function makePrefix(name: string): string {
  const words = name.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? 'SCH').slice(0, 3);
  return letters.toUpperCase().slice(0, 4) || 'SCH';
}

export async function searchSchools(q: string) {
  if (!q.trim()) return [];
  const rows = await School.find({ status: 'active', $or: [{ name: searchRegex(q) }, { slug: searchRegex(q) }, { 'address.town': searchRegex(q) }] })
    .select('name slug address.town address.state branding.logo')
    .limit(20)
    .lean();
  return rows.map((s: any) => ({ name: s.name, town: s.address?.town, state: s.address?.state, slug: s.slug, address: schoolLink(s.slug), logo: publicUrl(s.branding?.logo) }));
}

// ------------------------------------------------------------------ super admin console

export interface ListQuery {
  page: number;
  limit: number;
  q?: string;
  sort?: string;
  status?: string;
  state?: string;
  type?: string;
  format?: string;
}

export async function listSchools(query: ListQuery) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.state) filter['address.state'] = query.state;
  if (query.type) filter.types = query.type;
  if (query.q) filter.$or = [{ name: searchRegex(query.q) }, { slug: searchRegex(query.q) }];
  const p = paging(query as any, ['name', 'createdAt', 'status', 'lastActivityAt'], '-createdAt');
  const [rows, total] = await Promise.all([School.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), School.countDocuments(filter)]);
  const ids = rows.map((r: any) => r._id);
  const [students, staff, fees] = await asPlatform(() =>
    Promise.all([
      Student.aggregate([{ $match: { schoolId: { $in: ids } } }, { $group: { _id: '$schoolId', n: { $sum: 1 } } }]),
      Staff.aggregate([{ $match: { schoolId: { $in: ids } } }, { $group: { _id: '$schoolId', n: { $sum: 1 } } }]),
      Payment.aggregate([{ $match: { schoolId: { $in: ids }, status: 'successful', channel: 'paystack' } }, { $group: { _id: '$schoolId', total: { $sum: '$amountKobo' } } }])
    ])
  );
  const m = (arr: any[], key: string) => new Map(arr.map((x) => [String(x._id), x[key]]));
  const sm = m(students, 'n');
  const tm = m(staff, 'n');
  const fm = m(fees, 'total');
  return {
    rows: rows.map((s: any) => ({
      id: String(s._id),
      name: s.name,
      slug: s.slug,
      status: s.status,
      types: s.types,
      state: s.address?.state,
      lga: s.address?.lga,
      students: sm.get(String(s._id)) ?? 0,
      staff: tm.get(String(s._id)) ?? 0,
      feesCollectedKobo: fm.get(String(s._id)) ?? 0,
      lastActivityAt: s.lastActivityAt,
      createdAt: s.createdAt,
      possibleDuplicate: !!s.possibleDuplicate,
      plan: s.plan
    })),
    meta: { page: p.page, limit: p.limit, total }
  };
}

export async function schoolDetail(id: string) {
  const s: any = await need(School.findById(id).lean(), 'School');
  const owner = s.ownerUserId ? await User.findById(s.ownerUserId).select('firstName lastName phone email').lean() : null;
  const [setup, users, activity] = await Promise.all([
    forSchool(id, () => computeSetupProgress()),
    asPlatform(async () => ({
      staff: await Staff.countDocuments({ schoolId: id }),
      students: await Student.countDocuments({ schoolId: id }),
      guardians: await Guardian.countDocuments({ schoolId: id }),
      memberships: await Membership.countDocuments({ schoolId: id, status: 'active' })
    })),
    AuditLog.find({ schoolId: id }).sort({ at: -1 }).limit(20).lean()
  ]);
  const site = await asPlatform(() => Site.findOne({ schoolId: id }).select('status publishedAt takedown').lean());
  return {
    id: String(s._id),
    name: s.name,
    slug: s.slug,
    address: schoolLink(s.slug),
    status: s.status,
    statusReason: s.statusReason,
    types: s.types,
    location: s.address,
    contact: { phone: s.phone, email: s.email },
    registrationNumber: s.registrationNumber,
    possibleDuplicate: !!s.possibleDuplicate,
    createdVia: s.createdVia,
    owner,
    branding: { ...s.branding, logo: publicUrl(s.branding?.logo) },
    plan: s.plan,
    commission: s.commission,
    notes: s.notes,
    paystack: { configured: !!s.paystack?.subaccountCode, accountName: s.paystack?.accountName, accountLast4: s.paystack?.accountLast4 },
    setup,
    users,
    website: site ? { status: site.status, publishedAt: site.publishedAt, takedown: site.takedown } : { status: 'draft' },
    statusHistory: s.statusHistory ?? [],
    activity: activity.map((a: any) => ({ at: a.at, action: a.action, actor: a.actorUserId, reason: a.reason })),
    createdAt: s.createdAt
  };
}

async function changeStatus(id: string, to: 'active' | 'rejected' | 'suspended' | 'closed' | 'pending', reason?: string) {
  const c = me();
  const school: any = await need(School.findById(id), 'School');
  const from = school.status;
  assertTransition('school', from, to, 'This school');
  if (from === 'rejected' && to === 'pending' && school.resubmissions >= 1) throw stateConflict('A rejected school can be resubmitted once.');
  school.status = to;
  school.statusReason = reason;
  school.statusHistory.push({ status: to, at: new Date(), by: c.userId, reason });
  if (to === 'pending') school.resubmissions += 1;
  if (to === 'closed') school.closedAt = new Date();
  await school.save();
  await audit({ action: `platform.school.${to}`, entityType: 'school', entityId: id, schoolId: id, before: { status: from }, after: { status: to }, reason });
  return school;
}

export async function approveSchool(id: string) {
  const school = await changeStatus(id, 'active');
  await notify({ schoolId: id, event: 'school_decision', to: await ownerRecipients(id), vars: { school: school.name, decision: 'approved', note: 'You can now publish your website and send logins.' } });
  return school;
}

export async function rejectSchool(id: string, reason: string) {
  const school = await changeStatus(id, 'rejected', reason);
  await notify({ schoolId: id, event: 'school_decision', to: await ownerRecipients(id), vars: { school: school.name, decision: 'not approved', note: `Reason: ${reason}. You can correct the details and send them once more.` } });
  return school;
}

export async function suspendSchool(id: string, reason: string) {
  const school = await changeStatus(id, 'suspended', reason);
  await notify({ schoolId: id, event: 'school_status', to: await ownerRecipients(id), vars: { school: school.name, status: 'suspended', note: `Reason: ${reason}.` } });
  return school;
}

export async function reactivateSchool(id: string) {
  const school = await changeStatus(id, 'active');
  await notify({ schoolId: id, event: 'school_status', to: await ownerRecipients(id), vars: { school: school.name, status: 'active again', note: 'Everything is back as it was.' } });
  return school;
}

/** The owner corrects the details and sends them once more. */
export async function resubmitSchool() {
  const c = me();
  const school = await changeStatus(c.schoolId!, 'pending');
  return school;
}

export async function updateSchoolPlatformFields(id: string, patch: { plan?: any; commission?: any; notes?: string }) {
  const school: any = await need(School.findById(id), 'School');
  const before = { plan: school.plan, commission: school.commission, notes: school.notes };
  if (patch.plan) school.plan = { ...school.plan?.toObject?.(), ...patch.plan };
  if (patch.commission) school.commission = patch.commission;
  if (patch.notes !== undefined) school.notes = patch.notes;
  await school.save();
  await audit({ action: 'platform.school.update', entityType: 'school', entityId: id, schoolId: id, before, after: { plan: school.plan, commission: school.commission, notes: school.notes } });
  return school;
}

export interface AssistedInput {
  name: string;
  slug: string;
  types: string[];
  address: { street?: string; town?: string; lga: string; state: string };
  owner: { firstName: string; lastName: string; phone: string; email?: string };
  plan?: { name?: string; status?: string };
  commission?: { type: 'none' | 'flat' | 'percent'; value: number };
}

/** The super admin creates a school directly, sets it up on the owner's behalf and hands over by inviting the owner (ONB-09). */
export async function createAssistedSchool(input: AssistedInput) {
  const check = await checkSlug(input.slug, { town: input.address.town });
  if (!check.available && check.reason !== 'reserved') throw new AppError('duplicate', 'That web address is not available.', { fields: { slug: 'Not available.' }, details: { suggestions: check.suggestions } });
  const c = me();
  const school: any = await School.create({
    name: input.name,
    slug: input.slug,
    types: input.types,
    address: input.address,
    phone: input.owner.phone,
    email: input.owner.email,
    status: 'active',
    statusHistory: [{ status: 'active', at: new Date(), by: c.userId }],
    createdVia: 'assisted',
    plan: input.plan,
    commission: input.commission,
    settings: { receiptPrefix: makePrefix(input.name) },
    termsAcceptedAt: undefined
  });
  const staff: any = await forSchool(String(school._id), () =>
    Staff.create({ firstName: input.owner.firstName, lastName: input.owner.lastName, phone: input.owner.phone, email: input.owner.email, roles: ['owner'], status: 'invited' })
  );
  const invite = await forSchool(String(school._id), () => inviteStaffMember(staff, school, ['owner']));
  const ownerUser = await User.findOne({ phone: input.owner.phone }).select('_id').lean();
  if (ownerUser) await School.updateOne({ _id: school._id }, { ownerUserId: ownerUser._id });
  await audit({ action: 'platform.school.create_assisted', entityType: 'school', entityId: school._id, schoolId: String(school._id), after: { name: school.name, slug: school.slug } });
  return { id: String(school._id), slug: school.slug, name: school.name, address: schoolLink(school.slug), inviteSent: true, existingUser: invite.existingUser };
}

/** Ownership transfer is done by the super admin after verifying both parties. It is logged. */
export async function transferOwnership(id: string, newOwnerUserId: string, reason: string) {
  const school: any = await need(School.findById(id), 'School');
  const newOwner = await need(User.findById(newOwnerUserId).select('firstName lastName phone email status').lean(), 'User');
  if ((newOwner as any).status !== 'active') throw validation('The new owner’s account is not active.');
  await forSchool(id, async () => {
    const staffDoc = await Staff.findOne({ userId: newOwnerUserId });
    const staff = staffDoc ?? (await Staff.create({ userId: newOwnerUserId, firstName: (newOwner as any).firstName, lastName: (newOwner as any).lastName, phone: (newOwner as any).phone, email: (newOwner as any).email, roles: ['owner'], status: 'active' }));
    await Membership.updateOne(
      { userId: newOwnerUserId, schoolId: id, kind: 'staff' },
      { $addToSet: { roles: 'owner' }, $set: { staffId: staff._id, status: 'active' }, $inc: { permVersion: 1 } },
      { upsert: true }
    );
    await Staff.updateOne({ _id: staff._id }, { $addToSet: { roles: 'owner' } });
    // The previous owner keeps any other roles but loses 'owner'.
    if (school.ownerUserId && String(school.ownerUserId) !== newOwnerUserId) {
      await Membership.updateOne({ userId: school.ownerUserId, schoolId: id, kind: 'staff' }, { $pull: { roles: 'owner' }, $inc: { permVersion: 1 } });
      await Staff.updateOne({ userId: school.ownerUserId }, { $pull: { roles: 'owner' } });
    }
  });
  const before = { ownerUserId: school.ownerUserId };
  school.ownerUserId = newOwnerUserId;
  await school.save();
  await audit({ action: 'platform.school.transfer_ownership', entityType: 'school', entityId: id, schoolId: id, before, after: { ownerUserId: newOwnerUserId }, reason });
  return { ok: true };
}

// ------------------------------------------------------------------ metrics and logs

export async function platformMetrics() {
  const since7 = new Date(Date.now() - 7 * 86400_000);
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const [byStatus, signups7, activeUsers, volume, failedJobs, schoolsTotal, pending] = await Promise.all([
    School.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    School.countDocuments({ createdAt: { $gte: since7 } }),
    AuthSession.distinct('userId', { lastUsedAt: { $gte: since30 } }),
    asPlatform(() => Payment.aggregate([{ $match: { status: 'successful', channel: 'paystack' } }, { $group: { _id: null, volume: { $sum: '$amountKobo' }, commission: { $sum: '$commissionKobo' }, n: { $sum: 1 } } }])),
    Job.countDocuments({ status: 'failed' }),
    School.countDocuments({}),
    School.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10).select('name slug createdAt possibleDuplicate').lean()
  ]);
  const failedEvents = await WebhookEvent.countDocuments({ status: 'failed' });
  return {
    schoolsTotal,
    schoolsByStatus: Object.fromEntries(byStatus.map((b: any) => [b._id, b.n])),
    newSignupsLast7Days: signups7,
    activeUsersLast30Days: activeUsers.length,
    onlinePayments: { count: volume[0]?.n ?? 0, volumeKobo: volume[0]?.volume ?? 0, commissionKobo: volume[0]?.commission ?? 0 },
    failedJobs,
    failedPaymentEvents: failedEvents,
    pendingSchools: pending.map((s: any) => ({ id: String(s._id), name: s.name, slug: s.slug, createdAt: s.createdAt, possibleDuplicate: !!s.possibleDuplicate }))
  };
}

export async function platformPayments(query: { page: number; limit: number; status?: string; schoolId?: string; from?: string; to?: string }) {
  const filter: Record<string, unknown> = { channel: 'paystack' };
  if (query.status) filter.status = query.status;
  if (query.schoolId) filter.schoolId = query.schoolId;
  if (query.from || query.to) filter.createdAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(`${query.to}T23:59:59Z`) } : {}) };
  const p = paging(query as any, ['createdAt', 'amountKobo', 'status'], '-createdAt');
  const [rows, total, totals] = await asPlatform(() =>
    Promise.all([
      Payment.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(),
      Payment.countDocuments(filter),
      Payment.aggregate([{ $match: { ...filter, status: 'successful' } }, { $group: { _id: null, amountKobo: { $sum: '$amountKobo' }, commissionKobo: { $sum: '$commissionKobo' } } }])
    ])
  );
  const schools = new Map((await School.find({ _id: { $in: rows.map((r: any) => r.schoolId) } }).select('name').lean()).map((s: any) => [String(s._id), s.name]));
  return {
    rows: rows.map((r: any) => ({
      id: String(r._id),
      reference: r.reference,
      school: schools.get(String(r.schoolId)),
      schoolId: String(r.schoolId),
      status: r.status,
      amountKobo: r.amountKobo,
      chargeKobo: r.chargeKobo,
      commissionKobo: r.commissionKobo,
      flagged: !!r.flagged,
      flagReason: r.flagReason,
      purpose: r.purpose,
      createdAt: r.createdAt
    })),
    totals: { amountKobo: totals[0]?.amountKobo ?? 0, commissionKobo: totals[0]?.commissionKobo ?? 0 },
    meta: { page: p.page, limit: p.limit, total }
  };
}

export async function platformAuditLogs(query: { page: number; limit: number; schoolId?: string; userId?: string; action?: string; from?: string; to?: string }) {
  const filter: Record<string, unknown> = {};
  if (query.schoolId) filter.schoolId = query.schoolId;
  if (query.userId) filter.actorUserId = query.userId;
  if (query.action) filter.action = new RegExp(`^${escapeRegex(query.action)}`);
  if (query.from || query.to) filter.at = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(`${query.to}T23:59:59Z`) } : {}) };
  const p = paging(query as any, ['at', 'action'], '-at');
  const [rows, total] = await Promise.all([AuditLog.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), AuditLog.countDocuments(filter)]);
  return {
    rows: rows.map((a: any) => ({ id: String(a._id), at: a.at, action: a.action, schoolId: a.schoolId ? String(a.schoolId) : undefined, actorUserId: a.actorUserId ? String(a.actorUserId) : undefined, actorRoles: a.actorRoles, support: a.supportSession, entityType: a.entityType, entityId: a.entityId, reason: a.reason, before: a.before, after: a.after, ip: a.ip })),
    meta: { page: p.page, limit: p.limit, total }
  };
}

export const currentTermOf = (schoolId: string) => forSchool(schoolId, () => Term.findOne({ status: 'current' }).lean());
export { getCtx, notFound, Reply };
