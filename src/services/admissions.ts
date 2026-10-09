import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { audit } from '../core/audit';
import { forSchool, getCtx } from '../core/context';
import { formatNumber, nextSeq, seqKeyFor } from '../core/counters';
import { tx } from '../core/db';
import { AppError, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { me } from '../core/http';
import { randomToken, sha256 } from '../lib/crypto';
import { addDays, formatDate, todayLagos } from '../lib/dates';
import { formatKobo } from '../lib/money';
import { schoolLink } from '../lib/links';
import { normalizePhone } from '../lib/phone';
import { enqueue, registerJob } from '../jobs/queue';
import { assertUploadAllowed, files, type Purpose } from '../integrations/storage';
import { AcademicSession, AdmissionSettings, Application, ClassArm, ClassLevel, FeeStructure, FeeItem, Invoice, Student, StudentDocument, Term } from '../models';
import { createOtp, limitCodeRequests, requireOtp, sendCode } from './auth';
import { createInvoice } from './fees';
import { checkoutForApplication, paymentHooks } from './payments';
import { enrolStudent, findDuplicates } from './students';
import { fullName, loadSchool, need, platformSettings, adminRecipients } from './common';
import { confirmFile } from './files';
import { notify } from './notify';
import { currentSession } from './reach';
import { sumKobo } from '../lib/money';
import { photoUrl } from './common';

/** Admissions and enrolment (ADM-01 to ADM-11, flows F5 and F6). */

const DOC_KINDS = ['birth_certificate', 'last_result', 'passport', 'other'] as const;
const APP_TOKEN_HOURS = 24;

// ------------------------------------------------------------------ settings

export async function admissionSettings(sessionId?: string) {
  const session: any = sessionId ? await AcademicSession.findById(sessionId).lean() : await currentSession();
  if (!session) throw validation('There is no current session.');
  const s: any = (await AdmissionSettings.findOne({ sessionId: session._id }).lean()) ?? { sessionId: session._id, open: false, classLevelIds: [], requiredFields: [], requiredDocuments: [], applicationFeeKobo: 0, offerValidDays: 14, consentText: (await platformSettings()).legalTexts?.consent };
  return { ...s, sessionId: String(session._id), sessionName: session.name, classLevelIds: (s.classLevelIds ?? []).map(String) };
}

export async function saveAdmissionSettings(input: { sessionId?: string; open?: boolean; opensOn?: string; closesOn?: string; classLevelIds?: string[]; requiredFields?: string[]; requiredDocuments?: string[]; applicationFeeKobo?: number; offerValidDays?: number; consentText?: string }) {
  const session: any = input.sessionId ? await need(AcademicSession.findById(input.sessionId).lean(), 'Session') : await currentSession();
  if (!session) throw validation('There is no current session.');
  if (input.opensOn && input.closesOn && input.opensOn > input.closesOn) throw validation('Admissions close before they open.', { closesOn: 'Must be after the opening date.' });
  if (input.classLevelIds?.length && (await ClassLevel.countDocuments({ _id: { $in: input.classLevelIds } })) !== input.classLevelIds.length) throw notFound('Class level');
  const { sessionId, ...rest } = input;
  void sessionId;
  await AdmissionSettings.updateOne({ sessionId: session._id }, { $set: rest, $setOnInsert: { sessionId: session._id } }, { upsert: true });
  await audit({ action: 'admissions.settings.update', entityType: 'session', entityId: session._id, after: rest });
  return admissionSettings(String(session._id));
}

/** The settings that apply to the public form: the session whose admissions are open, today. */
async function openSettings() {
  const today = todayLagos();
  const all: any[] = await AdmissionSettings.find({ open: true }).lean();
  return all.find((s) => (!s.opensOn || s.opensOn <= today) && (!s.closesOn || s.closesOn >= today)) ?? null;
}

export async function publicAdmissions() {
  const school: any = await loadSchool();
  const s = await openSettings();
  const base = { school: school.name, open: false as boolean };
  if (!s || school.status !== 'active') return { ...base, message: 'Admissions are closed. Please check again later.' };
  const levels: any[] = await ClassLevel.find({ _id: { $in: s.classLevelIds }, active: true }).sort({ order: 1 }).lean();
  return {
    school: school.name,
    open: levels.length > 0,
    sessionId: String(s.sessionId),
    classes: levels.map((l) => ({ id: String(l._id), name: l.name })),
    requiredFields: s.requiredFields ?? [],
    requiredDocuments: s.requiredDocuments ?? [],
    documentKinds: DOC_KINDS,
    applicationFeeKobo: s.applicationFeeKobo ?? 0,
    consentText: s.consentText,
    opensOn: s.opensOn,
    closesOn: s.closesOn,
    ...(levels.length ? {} : { message: 'Admissions are closed. Please check again later.' })
  };
}

// ------------------------------------------------------------------ the public form (phone check, draft, submit)

interface AppClaims {
  typ: 'application';
  phone: string;
  sid: string;
}

export async function startApplication(phone: string, req: Request) {
  const school: any = await loadSchool();
  if (!(await openSettings()) || school.status !== 'active') throw new AppError('state_conflict', 'Admissions are closed.');
  await limitCodeRequests(phone, req.ip);
  const { code } = await createOtp(phone, `application:${school._id}`);
  await sendCode({ phone }, code);
}

export async function verifyApplication(phone: string, code: string) {
  const school: any = await loadSchool();
  await requireOtp(phone, `application:${school._id}`, code);
  const token = jwt.sign({ typ: 'application', phone, sid: String(school._id) } satisfies AppClaims, env.JWT_ACCESS_SECRET, { expiresIn: `${APP_TOKEN_HOURS}h` });
  const draft = await Application.findOne({ draftPhone: phone, status: 'draft' }).sort({ updatedAt: -1 }).lean();
  return { applicationToken: token, expiresInHours: APP_TOKEN_HOURS, draft: draft ? draftView(draft) : null };
}

/** The application token ties the form to the verified phone number and to this school. */
export function readAppToken(token: string | undefined): AppClaims {
  try {
    const c = jwt.verify(token ?? '', env.JWT_ACCESS_SECRET) as AppClaims;
    if (c.typ !== 'application' || c.sid !== getCtx()?.schoolId) throw new Error();
    return c;
  } catch {
    throw new AppError('unauthenticated', 'Your phone check has expired. Verify your phone number again.');
  }
}

const draftView = (a: any) => ({ id: String(a._id), child: a.child, guardian: a.guardian, classLevelId: a.classLevelId ? String(a.classLevelId) : undefined, previousSchool: a.previousSchool, documents: a.documents, updatedAt: a.updatedAt });

export async function saveDraft(token: string | undefined, input: any) {
  const claims = readAppToken(token);
  const s = await openSettings();
  if (!s) throw new AppError('state_conflict', 'Admissions are closed.');
  const guardian = { ...(input.guardian ?? {}), phone: claims.phone };
  const set: any = { child: input.child ?? {}, guardian, previousSchool: input.previousSchool, documents: (input.documents ?? []).slice(0, 8), draftPhone: claims.phone };
  if (input.classLevelId) set.classLevelId = input.classLevelId;
  const doc = await Application.findOneAndUpdate({ draftPhone: claims.phone, status: 'draft', sessionId: s.sessionId }, { $set: set, $setOnInsert: { sessionId: s.sessionId, status: 'draft', statusHistory: [{ status: 'draft', at: new Date() }] } }, { upsert: true, new: true });
  return draftView(doc);
}

export async function signApplicationFile(token: string | undefined, input: { mime: string; kind: string }) {
  readAppToken(token);
  const schoolId = getCtx()!.schoolId!;
  const purpose: Purpose = 'admission_document';
  assertUploadAllowed(purpose, input.mime);
  return files.signUpload({ schoolId, purpose, mime: input.mime });
}

function missingForSubmit(app: any, s: any): Record<string, string> {
  const problems: Record<string, string> = {};
  const c = app.child ?? {};
  const g = app.guardian ?? {};
  for (const [k, label] of [['firstName', 'First name'], ['lastName', 'Last name'], ['dob', 'Date of birth'], ['gender', 'Gender']] as const) if (!c[k]) problems[`child.${k}`] = `${label} is required.`;
  for (const [k, label] of [['firstName', 'First name'], ['lastName', 'Last name'], ['phone', 'Phone number']] as const) if (!g[k]) problems[`guardian.${k}`] = `${label} is required.`;
  if (!app.classLevelId) problems.classLevelId = 'Choose the class you are applying for.';
  else if (!(s.classLevelIds ?? []).map(String).includes(String(app.classLevelId))) problems.classLevelId = 'That class is not open for applications.';
  for (const f of s.requiredFields ?? []) {
    const val = f.startsWith('guardian.') ? g[f.slice(9)] : f.startsWith('child.') ? c[f.slice(6)] : (app as any)[f];
    if (!val) problems[f] = 'This field is required.';
  }
  for (const kind of s.requiredDocuments ?? []) if (!(app.documents ?? []).some((d: any) => d.kind === kind && d.file)) problems[`documents.${kind}`] = `Upload the ${kind.replace(/_/g, ' ')}.`;
  return problems;
}

/** Assign the application number, set the status to Submitted, and keep the history. Used on submit and when the application fee clears. */
/** The next application number, from the same counter that real submissions use, so numbers never repeat. */
export async function nextApplicationNumber(session?: ClientSession) {
  const school: any = await loadSchool();
  const seq = await nextSeq(seqKeyFor('{YY}', 'application'), session);
  return `${school.settings?.receiptPrefix ?? 'APP'}/APP/${formatNumber('{YY}/{SEQ:4}', seq)}`;
}

export async function finalizeSubmission(app: any, session?: ClientSession) {
  if (app.status !== 'draft') return app;
  app.number = await nextApplicationNumber(session);
  assertTransition('application', 'draft', 'submitted');
  app.status = 'submitted';
  app.submittedAt = new Date();
  app.statusHistory.push({ status: 'submitted', at: new Date() });
  await app.save({ session });
  return app;
}

paymentHooks.onApplicationFeePaid = async (app, session) => {
  await finalizeSubmission(app, session);
};
paymentHooks.afterApplicationFee = async (applicationId) => {
  const app: any = await Application.findById(applicationId).lean();
  if (app) await notifyReceived(app);
};

async function notifyReceived(app: any) {
  const school: any = await loadSchool();
  const level: any = app.classLevelId ? await ClassLevel.findById(app.classLevelId).lean() : null;
  await notify({
    event: 'application_received',
    to: [{ phone: app.guardian.phone, email: app.guardian.email, name: fullName(app.guardian), kind: 'parent' }],
    vars: { child: fullName(app.child), number: app.number, class: level?.name ?? '' }
  });
  await notify({ event: 'application_received', to: (await adminRecipients(String(school._id))).map((a) => ({ ...a, kind: 'admin' as const })), vars: { child: fullName(app.child), number: app.number, class: level?.name ?? '' } });
}

export async function submitApplication(token: string | undefined, input: { consent: boolean; ip?: string }) {
  const claims = readAppToken(token);
  const s: any = await openSettings();
  if (!s) throw new AppError('state_conflict', 'Admissions are closed.');
  const app: any = await need(Application.findOne({ draftPhone: claims.phone, status: 'draft', sessionId: s.sessionId }), 'Application');
  if (!input.consent) throw validation('Tick the consent statement to continue.', { consent: 'Required.' });
  const problems = missingForSubmit(app, s);
  if (Object.keys(problems).length) throw validation('Some details are missing.', problems);
  if (normalizePhone(app.guardian.phone) !== claims.phone) throw validation('The guardian phone must be the number you verified.', { 'guardian.phone': 'Must be the verified number.' });
  for (const d of app.documents ?? []) await files.confirm(d.file, getCtx()!.schoolId!, 'admission_document');

  const dup = await findDuplicates({ firstName: app.child.firstName, lastName: app.child.lastName, dob: app.child.dob }, claims.phone);
  app.possibleDuplicate = dup.duplicate;
  app.consent = { text: s.consentText, at: new Date(), ip: input.ip };

  // Optional application fee, paid online before the form is accepted.
  if ((s.applicationFeeKobo ?? 0) > 0 && !app.feePaid) {
    const school: any = await loadSchool();
    if (!school.paystack?.subaccountCode) throw new AppError('bank_not_set', 'Online payment is not set up at this school yet, so the application fee cannot be taken.');
    let invoice: any = app.applicationInvoiceId ? await Invoice.findById(app.applicationInvoiceId) : null;
    if (!invoice) {
      invoice = await tx((session) => createInvoice({ kind: 'application', lines: [{ label: 'Application fee', amountKobo: s.applicationFeeKobo }], applicationId: String(app._id), payerName: fullName(app.guardian), payerPhone: claims.phone }, session));
      app.applicationInvoiceId = invoice._id;
    }
    await app.save();
    const co = await checkoutForApplication(app, invoice, 'application');
    return { status: 'payment_required', payment: co, applicationId: String(app._id) };
  }
  await tx(async (session) => {
    await app.save({ session });
    await finalizeSubmission(app, session);
  });
  await notifyReceived(app);
  await audit({ action: 'admissions.application.submit', entityType: 'application', entityId: app._id, after: { number: app.number, possibleDuplicate: app.possibleDuplicate }, actorUserId: undefined });
  return { status: 'submitted', number: app.number, applicationId: String(app._id) };
}

// ------------------------------------------------------------------ status check and offers (public, no login)

const NEXT_STEP: Record<string, string> = {
  submitted: 'The school has your application and will review it.',
  under_review: 'The school is reviewing your application.',
  assessment_scheduled: 'Come for the entrance test or interview on the date shown.',
  offered: 'You have an offer. Pay the invoice before the offer ends to accept it.',
  accepted: 'Your place is confirmed. The school will enrol your child and send login details.',
  enrolled: 'Your child is enrolled. Check your phone for login details.',
  waitlisted: 'You are on the waiting list. The school will contact you if a place opens.',
  rejected: 'The school could not offer a place this time.',
  withdrawn: 'This application was withdrawn.',
  expired: 'The offer ended. Contact the school to renew it.'
};

export async function applicationStatus(number: string, phone: string) {
  const app: any = await Application.findOne({ number }).lean();
  // The same answer for a wrong number and a wrong phone, so numbers cannot be probed.
  if (!app || normalizePhone(app.guardian?.phone) !== phone) throw notFound('Application');
  const level: any = app.classLevelId ? await ClassLevel.findById(app.classLevelId).lean() : null;
  const out: any = { number: app.number, status: app.status, child: fullName(app.child), class: level?.name, nextStep: NEXT_STEP[app.status] ?? '', history: (app.statusHistory ?? []).map((h: any) => ({ status: h.status, at: h.at })) };
  if (app.status === 'assessment_scheduled' && app.assessment?.at) out.assessment = { kind: app.assessment.kind, at: app.assessment.at };
  if (['offered', 'expired'].includes(app.status) && app.offer) {
    const inv: any = app.offer.invoiceId ? await Invoice.findById(app.offer.invoiceId).lean() : null;
    out.offer = { expiresOn: app.offer.expiresOn, amountKobo: inv?.balanceKobo ?? 0, paid: inv ? inv.balanceKobo === 0 : false };
  }
  return out;
}

async function offerByToken(token: string) {
  const app: any = await Application.findOne({ 'offer.tokenHash': sha256(token) });
  if (!app) throw notFound('Offer');
  return app;
}

export async function offerView(token: string) {
  const app = await offerByToken(token);
  const school: any = await loadSchool();
  const level: any = await ClassLevel.findById(app.offer.classLevelId).lean();
  const inv: any = app.offer.invoiceId ? await Invoice.findById(app.offer.invoiceId).lean() : null;
  return { school: school.name, child: fullName(app.child), class: level?.name, status: app.status, expiresOn: app.offer.expiresOn, invoice: inv ? { number: inv.number, lines: inv.lines, totalKobo: inv.totalKobo, balanceKobo: inv.balanceKobo, status: inv.status } : null, canPay: app.status === 'offered' && !!inv && inv.balanceKobo > 0 };
}

export async function payOffer(token: string) {
  const app = await offerByToken(token);
  if (app.status === 'expired' || (app.status === 'offered' && app.offer.expiresOn < todayLagos())) throw stateConflict('This offer has ended. Contact the school to renew it.');
  if (app.status !== 'offered') throw stateConflict('This offer cannot be paid now.');
  const inv: any = await need(Invoice.findById(app.offer.invoiceId), 'Invoice');
  return checkoutForApplication(app, inv, 'offer');
}

// ------------------------------------------------------------------ staff pipeline

export async function listApplications(filter: { status?: string; q?: string; page: number; limit: number }) {
  const f: any = { status: { $ne: 'draft' } };
  if (filter.status) f.status = filter.status;
  if (filter.q) {
    const rx = new RegExp(filter.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ number: rx }, { 'child.firstName': rx }, { 'child.lastName': rx }, { 'guardian.phone': rx }];
  }
  const [rows, total] = await Promise.all([Application.find(f).sort({ submittedAt: -1 }).skip((filter.page - 1) * filter.limit).limit(filter.limit).lean(), Application.countDocuments(f)]);
  const levels = new Map<string, any>((await ClassLevel.find({ _id: { $in: rows.map((r: any) => r.classLevelId).filter(Boolean) } }).lean()).map((l: any) => [String(l._id), l]));
  const counts: any[] = await Application.aggregate([{ $match: { status: { $ne: 'draft' } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  return {
    rows: rows.map((a: any) => ({ id: String(a._id), number: a.number, status: a.status, child: fullName(a.child), class: levels.get(String(a.classLevelId))?.name, guardian: fullName(a.guardian), phone: a.guardian?.phone, possibleDuplicate: !!a.possibleDuplicate, submittedAt: a.submittedAt, offerExpiresOn: a.offer?.expiresOn })),
    total,
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n]))
  };
}

export async function applicationDetail(id: string) {
  const a: any = await need(Application.findById(id).lean(), 'Application');
  const level: any = a.classLevelId ? await ClassLevel.findById(a.classLevelId).lean() : null;
  const inv: any = a.offer?.invoiceId ? await Invoice.findById(a.offer.invoiceId).lean() : null;
  const feeInv: any = a.applicationInvoiceId ? await Invoice.findById(a.applicationInvoiceId).lean() : null;
  const dup = a.status !== 'enrolled' && a.child?.firstName ? await findDuplicates({ firstName: a.child.firstName, lastName: a.child.lastName, dob: a.child.dob }, a.guardian?.phone) : { students: [], applications: [] };
  return {
    id: String(a._id),
    number: a.number,
    status: a.status,
    child: a.child,
    guardian: a.guardian,
    classLevelId: a.classLevelId ? String(a.classLevelId) : undefined,
    class: level?.name,
    previousSchool: a.previousSchool,
    documents: (a.documents ?? []).filter((d: any) => d.file).map((d: any) => ({ kind: d.kind, name: d.name, file: d.file, url: photoUrl(d.file) })),
    photoUrl: photoUrl((a.documents ?? []).find((d: any) => d.kind === 'passport' && d.file)?.file),
    consent: a.consent,
    history: a.statusHistory,
    assessment: a.assessment,
    offer: a.offer ? { classLevelId: String(a.offer.classLevelId), expiresOn: a.offer.expiresOn, offeredAt: a.offer.offeredAt, invoice: inv ? { id: String(inv._id), number: inv.number, totalKobo: inv.totalKobo, balanceKobo: inv.balanceKobo, status: inv.status } : null } : null,
    applicationFee: feeInv ? { totalKobo: feeInv.totalKobo, paid: a.feePaid } : null,
    possibleDuplicate: !!a.possibleDuplicate,
    duplicates: { students: dup.students, applications: dup.applications.filter((x: any) => x.id !== id) },
    studentId: a.studentId ? String(a.studentId) : undefined,
    submittedAt: a.submittedAt
  };
}

async function notifyApplicant(app: any, status: string, note = '') {
  const level: any = app.classLevelId ? await ClassLevel.findById(app.classLevelId).lean() : null;
  await notify({
    event: 'application_status',
    to: [{ phone: app.guardian.phone, email: app.guardian.email, name: fullName(app.guardian), kind: 'parent' }],
    vars: { child: fullName(app.child), number: app.number, status: status.replace(/_/g, ' '), note, class: level?.name ?? '' }
  });
}

export async function changeApplicationStatus(id: string, to: 'under_review' | 'waitlisted' | 'rejected' | 'withdrawn', note?: string) {
  const c = me();
  const app: any = await need(Application.findById(id), 'Application');
  assertTransition('application', app.status, to, 'This application');
  app.status = to;
  app.statusHistory.push({ status: to, at: new Date(), by: c.userId, note });
  await app.save();
  await audit({ action: `admissions.application.${to}`, entityType: 'application', entityId: id, reason: note });
  await notifyApplicant(app, to, note ?? '');
  return app;
}

export async function scheduleAssessment(id: string, input: { kind: 'test' | 'interview'; at: string; notes?: string }) {
  const c = me();
  const app: any = await need(Application.findById(id), 'Application');
  assertTransition('application', app.status, 'assessment_scheduled', 'This application');
  app.assessment = { kind: input.kind, at: new Date(input.at), notes: input.notes };
  app.status = 'assessment_scheduled';
  app.statusHistory.push({ status: 'assessment_scheduled', at: new Date(), by: c.userId, note: `${input.kind} on ${formatDate(new Date(input.at))}` });
  await app.save();
  await notifyApplicant(app, 'assessment_scheduled', `Your ${input.kind} is on ${formatDate(new Date(input.at))}.`);
  return app;
}

/** The first-term fees for the level, from the fee structure's compulsory items. */
async function defaultOfferAmount(levelId: string): Promise<number> {
  const term: any = (await Term.findOne({ status: 'current' }).lean()) ?? (await Term.findOne({ status: 'upcoming' }).sort({ startDate: 1 }).lean());
  if (!term) return 0;
  const st: any = await FeeStructure.findOne({ termId: term._id, classLevelId: levelId }).lean();
  if (!st) return 0;
  const items = new Map<string, any>((await FeeItem.find({ _id: { $in: st.lines.map((l: any) => l.feeItemId) } }).lean()).map((i: any) => [String(i._id), i]));
  return sumKobo(st.lines.filter((l: any) => !items.get(String(l.feeItemId))?.optional).map((l: any) => l.amountKobo));
}

export async function makeOffer(id: string, input: { classLevelId?: string; amountKobo?: number; label?: string; expiresOn?: string }, renew = false) {
  const c = me();
  const school: any = await loadSchool();
  const app: any = await need(Application.findById(id), 'Application');
  assertTransition('application', app.status, 'offered', 'This application');
  const levelId = input.classLevelId ?? (renew ? String(app.offer?.classLevelId) : String(app.classLevelId));
  const level: any = await need(ClassLevel.findById(levelId).lean(), 'Class level');
  const settings: any = await admissionSettings();
  const expiresOn = input.expiresOn ?? addDays(todayLagos(), settings.offerValidDays ?? 14);
  if (expiresOn < todayLagos()) throw validation('The offer cannot end in the past.', { expiresOn: 'Choose a later date.' });

  let invoice: any = renew && app.offer?.invoiceId ? await Invoice.findById(app.offer.invoiceId) : null;
  if (!invoice || invoice.status === 'void') {
    const amount = input.amountKobo ?? (await defaultOfferAmount(levelId));
    if (!amount || amount <= 0) throw validation('Give the amount to pay to accept this offer. The fee structure for this class has no amounts yet.', { amountKobo: 'Required.' });
    invoice = await tx((session) => createInvoice({ kind: 'admission', lines: [{ label: input.label ?? 'Acceptance and first term fees', amountKobo: amount }], applicationId: String(app._id), payerName: fullName(app.guardian), payerPhone: app.guardian.phone, dueOn: expiresOn }, session));
  }
  const token = randomToken(24);
  app.status = 'offered';
  app.offer = { classLevelId: levelId, invoiceId: invoice._id, expiresOn, offeredAt: new Date(), tokenHash: sha256(token) };
  app.statusHistory.push({ status: 'offered', at: new Date(), by: c.userId, note: renew ? 'Offer renewed' : undefined });
  await app.save();
  await audit({ action: renew ? 'admissions.offer.renew' : 'admissions.offer.make', entityType: 'application', entityId: id, after: { classLevelId: levelId, expiresOn, invoiceId: String(invoice._id) } });
  await notify({
    event: 'offer_made',
    to: [{ phone: app.guardian.phone, email: app.guardian.email, name: fullName(app.guardian), kind: 'parent' }],
    vars: { child: fullName(app.child), class: level.name, amount: `₦${formatKobo(invoice.balanceKobo)}`, expires: formatDate(expiresOn), link: schoolLink(school.slug, `/admissions/offer/${token}`) }
  });
  return { application: app, invoice, offerLink: schoolLink(school.slug, `/admissions/offer/${token}`) };
}

/**
 * Enrol: create the student, guardian link and accounts, and set the status to Enrolled. A school setting lets staff enrol
 * from Offered before payment, in which case the invoice stays open in the parent's portal.
 */
export async function enrolApplication(id: string, input: { classArmId: string; confirmDuplicate?: boolean }) {
  const c = me();
  const school: any = await loadSchool();
  const app: any = await need(Application.findById(id), 'Application');
  const allowedFrom = school.settings?.allowEnrolBeforePayment ? ['accepted', 'offered'] : ['accepted'];
  if (!allowedFrom.includes(app.status)) throw stateConflict(app.status === 'offered' ? 'The offer has not been paid yet. Enrol after payment, or switch on enrolment before payment in the settings.' : `This application is ${app.status.replace(/_/g, ' ')}, so it cannot be enrolled.`);
  const arm: any = await need(ClassArm.findById(input.classArmId).lean(), 'Class');
  const levelId = String(app.offer?.classLevelId ?? app.classLevelId);
  if (String(arm.classLevelId) !== levelId) throw validation('Choose an arm of the class that was offered.', { classArmId: 'Not an arm of the offered class.' });

  if (!input.confirmDuplicate) {
    const dup = await findDuplicates({ firstName: app.child.firstName, lastName: app.child.lastName, dob: app.child.dob }, app.guardian.phone);
    if (dup.students.length) throw stateConflict('A student who looks the same is already in the school. Check, then confirm to continue.', { duplicates: dup, needsConfirmation: true });
  }
  const out = await enrolStudent(
    {
      child: { firstName: app.child.firstName, middleName: app.child.middleName, lastName: app.child.lastName, dob: app.child.dob, gender: app.child.gender, address: app.child.address, stateOfOrigin: app.child.stateOfOrigin, religion: app.child.religion },
      guardians: [{ firstName: app.guardian.firstName, lastName: app.guardian.lastName, phone: app.guardian.phone, email: app.guardian.email, address: app.guardian.address, relationship: app.guardian.relationship ?? 'parent', isPrimary: true, isFeePayer: true }],
      classArmId: input.classArmId,
      consent: { text: app.consent?.text, at: app.consent?.at, ip: app.consent?.ip, source: 'application' },
      applicationId: String(app._id),
      issueLogins: true
    },
    {}
  );
  // The passport photograph becomes the student's picture, and every uploaded document goes on the student's record.
  const passport = (app.documents ?? []).find((d: any) => d.kind === 'passport' && d.file);
  if (passport) await Student.updateOne({ _id: out.student._id }, { photo: passport.file });
  const KIND: Record<string, string> = { birth_certificate: 'Birth certificate', last_result: 'Last school report', passport: 'Passport photograph', other: 'Other document' };
  for (const d of app.documents ?? []) {
    if (!d.file) continue;
    await StudentDocument.create({ ownerType: 'student', ownerId: out.student._id, title: (d.name || KIND[d.kind] || 'Document').slice(0, 120), file: d.file, mime: '', visibleToGuardian: false, uploadedBy: c.userId });
  }
  // The offer invoice now belongs to the student, so the parent sees it (and its receipt) under the child.
  if (app.offer?.invoiceId) await Invoice.updateOne({ _id: app.offer.invoiceId }, { studentId: out.student._id });
  app.status = 'enrolled';
  app.studentId = out.student._id;
  app.statusHistory.push({ status: 'enrolled', at: new Date(), by: c.userId });
  await app.save();
  await audit({ action: 'admissions.application.enrol', entityType: 'application', entityId: id, after: { studentId: String(out.student._id), admissionNumber: out.student.admissionNumber } });
  return { studentId: String(out.student._id), admissionNumber: out.student.admissionNumber };
}

/** Daily: unpaid offers past their date become Expired. Staff can renew them. */
registerJob('expire-offers', async ({ schoolId }) => {
  const today = todayLagos();
  const due: any[] = await Application.find({ status: 'offered', 'offer.expiresOn': { $lt: today } });
  let expired = 0;
  for (const app of due) {
    const inv: any = app.offer?.invoiceId ? await Invoice.findById(app.offer.invoiceId).lean() : null;
    if (inv && inv.balanceKobo === 0) continue; // paid: it will be accepted
    app.status = 'expired';
    app.statusHistory.push({ status: 'expired', at: new Date(), note: 'The offer passed its date unpaid' });
    await app.save();
    await notify({ schoolId, event: 'application_status', to: [{ phone: app.guardian.phone, email: app.guardian.email, kind: 'parent' }], vars: { child: fullName(app.child), number: app.number, status: 'expired', note: 'The offer ended. Contact the school to renew it.' } });
    expired += 1;
  }
  return { expired };
});

export async function runExpireOffers() {
  const c = getCtx();
  return enqueue('expire-offers', {}, { schoolId: c?.schoolId });
}

export { forSchool, Student };
