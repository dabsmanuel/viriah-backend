import type { ClientSession } from 'mongoose';
import { env } from '../config/env';
import { audit } from '../core/audit';
import { asPlatform, forSchool, getCtx } from '../core/context';
import { nextReceiptNumber } from '../core/counters';
import { tx } from '../core/db';
import { AppError, duplicate, forbidden, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { me } from '../core/http';
import { allocateRoundAmount, minimumPartPayment, quote as quoteCharge, type Allocation, type CommissionSpec } from '../calc/fees';
import { randomCode, safeEqual } from '../lib/crypto';
import { formatDate, lagosDate, minutesFromNow, todayLagos } from '../lib/dates';
import { formatKobo, sumKobo } from '../lib/money';
import { portalLink, schoolLink, schoolOrigin } from '../lib/links';
import { enqueue, registerJob } from '../jobs/queue';
import { files, saveGenerated } from '../integrations/storage';
import { paystack, signWebhook } from '../integrations/paystack';
import { sendEmail } from '../integrations/email';
import { AcademicSession, Approval, Application, ClassArm, ClassLevel, Credit, Enrolment, Guardian, Invoice, Membership, Payment, Receipt, School, Student, StudentGuardian, Term, TermResult, User, WebhookEvent } from '../models';
import { fullName, loadSchool, need, platformSettings, staffRecipients } from './common';
import { confirmFile } from './files';
import { createOtp, requireOtp, sendCode } from './auth';
import { recomputeInvoice, studentBalance } from './fees';
import { creditUnits, notify } from './notify';
import { currentSession, myChildIds } from './reach';
import { receiptPdf } from '../templates/pdf';
import { classNames } from './students';

/**
 * Payments and receipts (Document 3, section 9; Document 5, M9). Online payments settle to the school's own bank account
 * through a Paystack subaccount, and any platform commission is taken as a split of the same transaction. A payment is
 * confirmed by Paystack's server notification, double-checked with a verification call, and is never applied twice.
 */

type Session = ClientSession | undefined;

/** Set by the admissions service so an application fee can finish a submission without a circular import. */
export const paymentHooks: { onApplicationFeePaid?: (application: any, session: Session) => Promise<void>; afterApplicationFee?: (applicationId: string) => Promise<void> } = {};

// ------------------------------------------------------------------ settings

async function effectiveCommission(school: any): Promise<CommissionSpec> {
  if (school.commission?.type && school.commission.type !== 'none') return { type: school.commission.type, value: school.commission.value };
  const p = await platformSettings();
  return { type: p.defaultCommission?.type ?? 'none', value: p.defaultCommission?.value ?? 0 };
}

const ratesOf = async () => {
  const p = await platformSettings();
  const r = p.paymentRates;
  return { percent: r.percent, flatKobo: r.flatKobo, flatWaivedBelowKobo: r.flatWaivedBelowKobo, capKobo: r.capKobo };
};

function assertOnlineReady(school: any) {
  if (school.status !== 'active') throw new AppError('school_not_active', 'Online payment is switched off for this school right now.');
  if (!school.paystack?.subaccountCode) throw new AppError('bank_not_set', 'Online payment is not set up yet. Pay at the school and the bursar will record it.');
}

// ------------------------------------------------------------------ items and quote

export interface PayItem {
  invoiceId: string;
  amountKobo?: number;
}

/** Resolve the parent's chosen invoices into allocations. Full or part payment, subject to the school's rule. */
async function resolveItems(items: PayItem[], school: any): Promise<{ allocations: Allocation[]; invoices: any[] }> {
  if (!items.length) throw validation('Choose at least one invoice.', { items: 'Choose an invoice.' });
  const mine = new Set(await myChildIds());
  const ids = items.map((i) => i.invoiceId);
  if (new Set(ids).size !== ids.length) throw validation('An invoice is listed twice.', { items: 'Duplicate invoice.' });
  const invoices: any[] = await Invoice.find({ _id: { $in: ids } }).lean();
  const allocations: Allocation[] = [];
  for (const it of items) {
    const inv = invoices.find((x) => String(x._id) === it.invoiceId);
    if (!inv || !inv.studentId || !mine.has(String(inv.studentId))) throw notFound('Invoice');
    if (!['issued', 'part_paid'].includes(inv.status)) throw stateConflict(`Invoice ${inv.number} is not open for payment.`);
    const amount = it.amountKobo ?? inv.balanceKobo;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw validation('Enter an amount above zero.', { items: 'Amount must be above zero.' });
    if (amount > inv.balanceKobo) throw validation(`The most you can pay on invoice ${inv.number} is ₦${formatKobo(inv.balanceKobo)}.`, { items: 'Above the balance.' });
    if (amount < inv.balanceKobo) {
      if (!school.settings?.partPayment?.enabled) throw validation('This school takes the full amount of an invoice.', { items: 'Part payment is not allowed.' });
      const min = minimumPartPayment(inv.totalKobo, inv.paidKobo, school.settings?.partPayment?.minPercent ?? 0);
      if (amount < min) throw validation(`The first payment on this invoice must be at least ₦${formatKobo(min)}.`, { items: `Minimum ₦${formatKobo(min)}.` });
    }
    allocations.push({ invoiceId: it.invoiceId, studentId: String(inv.studentId), amountKobo: amount });
  }
  return { allocations, invoices };
}

export async function quotePayment(items: PayItem[]) {
  const school = await loadSchool();
  const { allocations } = await resolveItems(items, school);
  const feesKobo = sumKobo(allocations.map((a) => a.amountKobo));
  const q = quoteCharge(feesKobo, school.settings?.chargeBearer ?? 'parent', await effectiveCommission(school), await ratesOf());
  return { feesKobo: q.feesKobo, chargeKobo: q.chargeKobo, totalKobo: q.totalKobo, chargeBorneBy: q.chargeBorneBy, onlineAvailable: school.status === 'active' && !!school.paystack?.subaccountCode };
}

const payerEmail = (g: any) => g?.email || `g-${g?._id ?? 'x'}@pay.${env.PLATFORM_DOMAIN}`;

// ------------------------------------------------------------------ checkout

export async function checkout(items: PayItem[]) {
  const c = me();
  const school = await loadSchool();
  assertOnlineReady(school);
  const { allocations } = await resolveItems(items, school);
  const feesKobo = sumKobo(allocations.map((a) => a.amountKobo));
  const q = quoteCharge(feesKobo, school.settings?.chargeBearer ?? 'parent', await effectiveCommission(school), await ratesOf());
  const guardian: any = c.guardianId ? await Guardian.findById(c.guardianId).lean() : null;

  const reference = `${school.settings?.receiptPrefix ?? 'PAY'}-${randomCode(14)}`;
  const payment: any = await Payment.create({
    reference,
    channel: 'paystack',
    status: 'initiated',
    amountKobo: feesKobo,
    chargeKobo: q.chargeKobo,
    commissionKobo: q.commissionKobo,
    requestedTotalKobo: q.totalKobo,
    payerGuardianId: c.guardianId,
    payerName: fullName(guardian),
    allocations,
    recordedBy: c.userId,
    purpose: 'fees'
  });
  try {
    const init = await paystack().initialize({
      email: payerEmail(guardian),
      amountKobo: q.totalKobo,
      reference,
      callbackUrl: `${schoolOrigin(school.slug)}/portal/parent/pay/return?reference=${reference}`,
      subaccount: school.paystack.subaccountCode,
      transactionChargeKobo: q.commissionKobo,
      bearer: 'subaccount',
      metadata: { schoolId: String(school._id), paymentId: String(payment._id) }
    });
    return { paymentId: String(payment._id), reference, authorizationUrl: init.authorizationUrl, feesKobo: q.feesKobo, chargeKobo: q.chargeKobo, totalKobo: q.totalKobo };
  } catch (e) {
    await Payment.updateOne({ _id: payment._id }, { status: 'failed', note: (e as Error).message });
    throw e;
  }
}

/** The payer has no account yet (application fee, offer payment), so the request is authorised by a signed link tied to the application. */
export async function checkoutForApplication(application: any, invoice: any, purpose: 'application' | 'offer') {
  const school = await loadSchool();
  assertOnlineReady(school);
  if (!['issued', 'part_paid'].includes(invoice.status)) throw stateConflict('This invoice is already paid or closed.');
  const feesKobo = invoice.balanceKobo;
  const q = quoteCharge(feesKobo, school.settings?.chargeBearer ?? 'parent', await effectiveCommission(school), await ratesOf());
  const reference = `${school.settings?.receiptPrefix ?? 'PAY'}-${randomCode(14)}`;
  const payment: any = await Payment.create({
    reference,
    channel: 'paystack',
    status: 'initiated',
    amountKobo: feesKobo,
    chargeKobo: q.chargeKobo,
    commissionKobo: q.commissionKobo,
    requestedTotalKobo: q.totalKobo,
    payerName: fullName(application.guardian),
    applicationId: application._id,
    allocations: [{ invoiceId: invoice._id, amountKobo: feesKobo }],
    purpose
  });
  try {
    const init = await paystack().initialize({
      email: application.guardian.email || `a-${application._id}@pay.${env.PLATFORM_DOMAIN}`,
      amountKobo: q.totalKobo,
      reference,
      callbackUrl: `${schoolOrigin(school.slug)}/admissions/status?reference=${reference}`,
      subaccount: school.paystack.subaccountCode,
      transactionChargeKobo: q.commissionKobo,
      bearer: 'subaccount',
      metadata: { schoolId: String(school._id), paymentId: String(payment._id), applicationId: String(application._id) }
    });
    return { paymentId: String(payment._id), reference, authorizationUrl: init.authorizationUrl, totalKobo: q.totalKobo, chargeKobo: q.chargeKobo, feesKobo };
  } catch (e) {
    await Payment.updateOne({ _id: payment._id }, { status: 'failed', note: (e as Error).message });
    throw e;
  }
}

/** SMS unit purchases are ordinary Paystack payments to the platform's main account with no subaccount. */
export async function checkoutSmsUnits(units: number) {
  const c = me();
  const school = await loadSchool();
  const settings = await platformSettings();
  const amountKobo = units * settings.smsUnitPriceKobo;
  const reference = `SMS-${school.settings?.receiptPrefix ?? 'X'}-${randomCode(12)}`;
  const payment: any = await Payment.create({ reference, channel: 'paystack', status: 'initiated', amountKobo, requestedTotalKobo: amountKobo, allocations: [], recordedBy: c.userId, purpose: 'sms_units', note: String(units) });
  const user = await User.findById(c.userId).select('email').lean();
  try {
    const init = await paystack().initialize({
      email: user?.email || school.email || `s-${school._id}@pay.${env.PLATFORM_DOMAIN}`,
      amountKobo,
      reference,
      callbackUrl: `${schoolOrigin(school.slug)}/portal/staff/settings?tab=sms&reference=${reference}`,
      metadata: { schoolId: String(school._id), paymentId: String(payment._id), units }
    });
    return { paymentId: String(payment._id), reference, authorizationUrl: init.authorizationUrl, units, amountKobo };
  } catch (e) {
    await Payment.updateOne({ _id: payment._id }, { status: 'failed', note: (e as Error).message });
    throw e;
  }
}

// ------------------------------------------------------------------ settle allocations (shared by every way money arrives)

/**
 * Apply allocations against the invoices' current balances. An amount larger than an invoice's balance (the invoice was
 * paid another way, or voided, since checkout) is held as credit. Returns what was applied and what is left over.
 */
async function settleAllocations(allocs: Allocation[], session: Session): Promise<{ applied: Allocation[]; leftoverKobo: number; leftoverStudentId?: string }> {
  const applied: Allocation[] = [];
  let leftover = 0;
  let leftoverStudent: string | undefined;
  for (const a of allocs) {
    const inv: any = await Invoice.findById(a.invoiceId).session(session ?? null).lean();
    const room = inv && inv.status !== 'void' ? Math.max(0, inv.totalKobo - inv.paidKobo) : 0;
    const use = Math.min(a.amountKobo, room);
    if (use > 0) applied.push({ invoiceId: a.invoiceId, studentId: a.studentId ?? (inv?.studentId ? String(inv.studentId) : undefined), amountKobo: use });
    if (a.amountKobo - use > 0) {
      leftover += a.amountKobo - use;
      leftoverStudent ??= a.studentId ?? (inv?.studentId ? String(inv.studentId) : undefined);
    }
  }
  return { applied, leftoverKobo: leftover, leftoverStudentId: leftoverStudent };
}

/** One receipt per child (one per payer for application and offer payments). A receipt is created in the same transaction as the payment's success. */
async function createReceipts(payment: any, extra: { creditKobo?: number; creditStudentId?: string }, session: Session) {
  const school: any = await loadSchool();
  const prefix = school.settings?.receiptPrefix ?? 'RCT';
  const byStudent = new Map<string, Array<{ invoiceNumber: string; label: string; amountKobo: number }>>();
  const invoices = new Map<string, any>();
  for (const a of payment.allocations) {
    const inv: any = invoices.get(String(a.invoiceId)) ?? (await Invoice.findById(a.invoiceId).session(session ?? null).lean());
    invoices.set(String(a.invoiceId), inv);
    const key = String(a.studentId ?? inv?.studentId ?? 'none');
    const label = inv?.kind === 'opening_balance' ? 'Balance brought forward' : inv?.kind === 'application' ? 'Application fee' : inv?.kind === 'admission' ? 'Acceptance fee' : (inv?.lines ?? []).map((l: any) => l.label).join(', ') || 'School fees';
    if (!byStudent.has(key)) byStudent.set(key, []);
    byStudent.get(key)!.push({ invoiceNumber: inv?.number ?? '-', label, amountKobo: a.amountKobo });
  }
  if (extra.creditKobo && extra.creditKobo > 0) {
    const key = extra.creditStudentId ?? 'none';
    if (!byStudent.has(key)) byStudent.set(key, []);
    byStudent.get(key)!.push({ invoiceNumber: '-', label: 'Credit on account (applied to your next invoice)', amountKobo: extra.creditKobo });
  }
  const receipts: any[] = [];
  const method = payment.channel === 'paystack' ? 'Online (Paystack)' : payment.channel === 'pos' ? 'POS' : payment.channel === 'bank' ? 'Bank teller' : payment.channel === 'transfer' ? 'Bank transfer' : payment.channel === 'cash' ? 'Cash' : payment.channel;
  for (const [key, lines] of byStudent) {
    const studentId = key === 'none' ? undefined : key;
    const number = await nextReceiptNumber(prefix, session);
    const balance = studentId ? await studentBalance(studentId, session) : 0;
    const [r] = await Receipt.create(
      [
        {
          number,
          paymentId: payment._id,
          studentId,
          payerName: payment.payerName,
          amountKobo: sumKobo(lines.map((l) => l.amountKobo)),
          balanceAfterKobo: balance,
          method,
          paidOn: payment.paidOn ?? lagosDate(payment.provider?.paidAt ?? new Date()),
          lines,
          verificationCode: randomCode(10)
        }
      ],
      { session }
    );
    receipts.push(r);
  }
  return receipts;
}

/** After commit: render the receipt PDFs and tell the parent. */
async function afterPayment(payment: any, receipts: any[], opts: { notifyParent?: boolean } = {}) {
  const schoolId = String(payment.schoolId);
  const school: any = await School.findById(schoolId).select('slug name').lean();
  for (const r of receipts) await enqueue('generate-receipt-pdf', { receiptId: String(r._id) }, { schoolId });
  if (payment.purpose === 'application' && payment.applicationId && paymentHooks.afterApplicationFee) await paymentHooks.afterApplicationFee(String(payment.applicationId));
  if (opts.notifyParent === false) return;
  const studentIds = [...new Set(receipts.map((r) => r.studentId).filter(Boolean).map(String))];
  const links: any[] = studentIds.length ? await StudentGuardian.find({ studentId: { $in: studentIds }, isFeePayer: true, access: { $ne: 'none' } }).lean() : [];
  const guardianIds = new Set<string>([...links.map((l) => String(l.guardianId)), ...(payment.payerGuardianId ? [String(payment.payerGuardianId)] : [])]);
  const guardians: any[] = await Guardian.find({ _id: { $in: [...guardianIds] } }).lean();
  const students = new Map<string, any>((await Student.find({ _id: { $in: studentIds } }).select('firstName lastName').lean()).map((s: any) => [String(s._id), s]));
  const first = receipts[0];
  const names = studentIds.map((id) => fullName(students.get(id))).join(' and ');
  const recipients = guardians.map((g) => ({ userId: g.userId ? String(g.userId) : undefined, phone: g.phone, email: g.email, name: fullName(g), kind: 'parent' as const }));
  if (!recipients.length && payment.applicationId) {
    const app: any = await Application.findById(payment.applicationId).lean();
    if (app?.guardian?.phone) recipients.push({ userId: undefined, phone: app.guardian.phone, email: app.guardian.email, name: fullName(app.guardian), kind: 'parent' });
  }
  await notify({
    schoolId,
    event: 'payment_success',
    to: recipients,
    vars: { child: names || 'your child', amount: `₦${formatKobo(sumKobo(receipts.map((r) => r.amountKobo)))}`, receipt: first.number, link: `${schoolLink(school.slug, `/verify/${first.verificationCode}`)}` }
  });
  const bursars = await staffRecipients(schoolId, ['bursar', 'owner'], 'staff');
  await notify({ schoolId, event: 'payment_success', to: bursars.map((b) => ({ ...b, kind: 'staff' as const })), vars: { child: names || 'a student', amount: `₦${formatKobo(sumKobo(receipts.map((r) => r.amountKobo)))}`, receipt: first.number, link: '' } });
}

// ------------------------------------------------------------------ verify and apply

export interface ApplyResult {
  payment: any;
  applied: boolean;
  receipts: any[];
}

/**
 * Called by the webhook job, by the callback page and by the reconciliation job. It is idempotent: whichever arrives second
 * does nothing. If the verified amount differs from the expected amount, the payment is applied at the amount actually
 * received and flagged for the bursar.
 */
export async function verifyAndApply(reference: string): Promise<ApplyResult> {
  const found: any = await asPlatform(() => Payment.findOne({ reference }).lean());
  if (!found) throw notFound('Payment');
  return forSchool(String(found.schoolId), () => verifyAndApplyInSchool(reference));
}

async function verifyAndApplyInSchool(reference: string): Promise<ApplyResult> {
  const payment: any = await Payment.findOne({ reference });
  if (!payment) throw notFound('Payment');
  if (payment.status === 'successful') return { payment, applied: false, receipts: await Receipt.find({ paymentId: payment._id }).lean() };
  if (!['initiated', 'abandoned'].includes(payment.status)) return { payment, applied: false, receipts: [] };

  const v = await paystack().verify(reference);
  if (v.status === 'failed') {
    await Payment.updateOne({ _id: payment._id, status: { $in: ['initiated', 'abandoned'] } }, { status: 'failed' });
    return { payment: await Payment.findById(payment._id), applied: false, receipts: [] };
  }
  if (v.status === 'abandoned') {
    await Payment.updateOne({ _id: payment._id, status: 'initiated' }, { status: 'abandoned' });
    return { payment: await Payment.findById(payment._id), applied: false, receipts: [] };
  }
  if (v.status !== 'success') return { payment, applied: false, receipts: [] };
  if (v.currency !== 'NGN') {
    await Payment.updateOne({ _id: payment._id }, { flagged: true, flagReason: `Unexpected currency ${v.currency}`, status: 'failed' });
    return { payment: await Payment.findById(payment._id), applied: false, receipts: [] };
  }

  const out = await tx(async (session) => {
    // Claim the payment. Two arrivals at once: one wins, the other sees it already applied.
    const claimed: any = await Payment.findOneAndUpdate(
      { _id: payment._id, status: { $in: ['initiated', 'abandoned'] } },
      { $set: { status: 'successful', 'provider.id': v.id, 'provider.channel': v.channel, 'provider.paidAt': v.paidAt ? new Date(v.paidAt) : new Date(), 'provider.fees': v.feesKobo, 'provider.receivedKobo': v.amountKobo } },
      { new: true, session }
    );
    if (!claimed) return null;
    return applySuccessfulPayment(claimed, v.amountKobo, session);
  });
  if (!out) {
    const again: any = await Payment.findById(payment._id);
    return { payment: again, applied: false, receipts: await Receipt.find({ paymentId: payment._id }).lean() };
  }
  await afterPayment(out.payment, out.receipts, { notifyParent: out.payment.purpose !== 'sms_units' });
  return { payment: out.payment, applied: true, receipts: out.receipts };
}

async function applySuccessfulPayment(payment: any, receivedKobo: number, session: Session) {
  const expected = payment.requestedTotalKobo || payment.amountKobo + payment.chargeKobo;
  let flagReason: string | undefined;

  // ---- SMS units: credited once per payment reference
  if (payment.purpose === 'sms_units') {
    const units = Number(payment.note) || Math.floor(receivedKobo / ((await platformSettings()).smsUnitPriceKobo || 1));
    await creditUnits(units, 'purchase', payment.reference, session);
    await audit({ action: 'sms.units.purchase', entityType: 'payment', entityId: payment._id, after: { units, amountKobo: receivedKobo }, session });
    return { payment, receipts: [] as any[] };
  }

  // ---- fees credited: what was received less the payment charge, never more than the invoices allow
  let credited = payment.amountKobo;
  if (receivedKobo !== expected) {
    flagReason = `Expected ₦${formatKobo(expected)} but received ₦${formatKobo(receivedKobo)}. Applied as received.`;
    credited = Math.max(0, receivedKobo - payment.chargeKobo);
  }
  let allocs: Allocation[] = payment.allocations.map((a: any) => ({ invoiceId: String(a.invoiceId), studentId: a.studentId ? String(a.studentId) : undefined, amountKobo: a.amountKobo }));
  const stored = sumKobo(allocs.map((a) => a.amountKobo));
  let extra = 0;
  if (credited < stored) {
    let left = credited;
    allocs = allocs.map((a) => {
      const take = Math.min(left, a.amountKobo);
      left -= take;
      return { ...a, amountKobo: take };
    }).filter((a) => a.amountKobo > 0);
  } else if (credited > stored) extra = credited - stored;

  const settled = await settleAllocations(allocs, session);
  const leftover = settled.leftoverKobo + extra;
  const creditStudent = settled.leftoverStudentId ?? allocs[0]?.studentId ?? payment.allocations[0]?.studentId?.toString();

  payment.allocations = settled.applied;
  payment.amountKobo = sumKobo(settled.applied.map((a) => a.amountKobo)) + leftover;
  if (flagReason) {
    payment.flagged = true;
    payment.flagReason = flagReason;
  }
  await payment.save({ session });
  for (const id of new Set(settled.applied.map((a) => a.invoiceId))) await recomputeInvoice(id, session);

  if (leftover > 0 && creditStudent) {
    await Credit.create([{ studentId: creditStudent, amountKobo: leftover, sourcePaymentId: payment._id }], { session });
  }

  // ---- application fee and offer payments: move the application on
  if (payment.applicationId) await applyApplicationPayment(payment, session);

  const receipts = await createReceipts(payment, { creditKobo: leftover, creditStudentId: creditStudent }, session);
  await audit({ action: 'fees.payment.success', entityType: 'payment', entityId: payment._id, after: { reference: payment.reference, amountKobo: payment.amountKobo, commissionKobo: payment.commissionKobo, flagged: !!flagReason }, session });
  return { payment, receipts };
}

async function applyApplicationPayment(payment: any, session: Session) {
  const app: any = await Application.findById(payment.applicationId).session(session ?? null);
  if (!app) return;
  if (payment.purpose === 'application') {
    app.feePaid = true;
    await app.save({ session });
    if (paymentHooks.onApplicationFeePaid) await paymentHooks.onApplicationFeePaid(app, session);
  } else if (payment.purpose === 'offer' && app.status === 'offered') {
    app.status = 'accepted';
    app.statusHistory.push({ status: 'accepted', at: new Date(), note: 'Offer paid online' });
    await app.save({ session });
  }
}

// ------------------------------------------------------------------ offline payments

export interface OfflineInput {
  studentId: string;
  amountKobo: number;
  channel: 'cash' | 'bank' | 'pos' | 'transfer';
  paidOn: string;
  bankReference?: string;
  proofFile?: string;
  allocations?: Array<{ invoiceId: string; amountKobo: number }>;
  note?: string;
  confirmDuplicate?: boolean;
}

async function openInvoicesOf(studentId: string, session?: Session) {
  const rows: any[] = await Invoice.find({ studentId, status: { $in: ['issued', 'part_paid'] }, balanceKobo: { $gt: 0 } }).session(session ?? null).lean();
  return rows.map((i) => ({ invoiceId: String(i._id), studentId, balanceKobo: i.balanceKobo, createdAt: i.createdAt }));
}

/** The bursar records offline payments (cash, bank teller, POS, transfer) with a reference and optional proof image. */
export async function recordOffline(input: OfflineInput) {
  const c = me();
  await need(Student.findById(input.studentId).select('_id').lean(), 'Student');
  if (input.bankReference && !input.confirmDuplicate) {
    const dup: any = await Payment.findOne({ bankReference: input.bankReference, status: { $in: ['successful', 'pending_confirmation'] } }).lean();
    if (dup) throw duplicate(`A payment with this bank reference was recorded on ${formatDate(dup.paidOn ?? dup.createdAt)}.`, { paymentId: String(dup._id) });
  }
  if (input.proofFile) await confirmFile(input.proofFile, 'payment_proof');

  let allocs: Allocation[];
  if (input.allocations?.length) {
    allocs = input.allocations.map((a) => ({ invoiceId: a.invoiceId, studentId: input.studentId, amountKobo: a.amountKobo }));
    const invs: any[] = await Invoice.find({ _id: { $in: allocs.map((a) => a.invoiceId) }, studentId: input.studentId }).lean();
    if (invs.length !== allocs.length) throw notFound('Invoice');
    if (sumKobo(allocs.map((a) => a.amountKobo)) > input.amountKobo) throw validation('The allocations add up to more than the amount paid.', { allocations: 'Above the amount.' });
  } else {
    allocs = allocateRoundAmount(input.amountKobo, await openInvoicesOf(input.studentId)).allocations;
  }

  const guardian: any = await primaryGuardianOf(input.studentId);
  const school: any = await loadSchool();
  const out = await tx(async (session) => {
    const reference = `OFF-${school.settings?.receiptPrefix ?? 'X'}-${randomCode(10)}`;
    const [payment] = await Payment.create(
      [{ reference, channel: input.channel, status: 'successful', amountKobo: input.amountKobo, allocations: allocs, payerGuardianId: guardian?._id, payerName: fullName(guardian), bankReference: input.bankReference, paidOn: input.paidOn, proofFile: input.proofFile, note: input.note, recordedBy: c.userId, purpose: 'fees' }],
      { session }
    );
    const settled = await settleAllocations(allocs, session);
    // Anything larger than the balance is held as credit and applied to the next invoice.
    const leftover = input.amountKobo - sumKobo(settled.applied.map((a) => a.amountKobo));
    payment.allocations = settled.applied;
    await payment.save({ session });
    for (const id of new Set(settled.applied.map((a) => a.invoiceId))) await recomputeInvoice(id, session);
    if (leftover > 0) await Credit.create([{ studentId: input.studentId, amountKobo: leftover, sourcePaymentId: payment._id }], { session });
    const receipts = await createReceipts(payment, { creditKobo: leftover, creditStudentId: input.studentId }, session);
    await audit({ action: 'fees.payment.record', entityType: 'payment', entityId: payment._id, after: { amountKobo: input.amountKobo, channel: input.channel, bankReference: input.bankReference, creditKobo: leftover }, session });
    return { payment, receipts, leftover };
  });
  await afterPayment(out.payment, out.receipts);
  const r = out.receipts[0];
  return { paymentId: String(out.payment._id), receipt: { id: String(r._id), number: r.number, balanceAfterKobo: r.balanceAfterKobo }, creditKobo: out.leftover };
}

async function primaryGuardianOf(studentId: string) {
  const link: any = await StudentGuardian.findOne({ studentId, access: { $ne: 'none' } }).sort({ isFeePayer: -1, isPrimary: -1 }).lean();
  return link ? Guardian.findById(link.guardianId).lean() : null;
}

// ------------------------------------------------------------------ proofs of payment

export async function uploadProof(input: { studentId: string; amountKobo: number; paidOn: string; bankReference?: string; proofFile: string; items?: PayItem[]; note?: string }) {
  const c = me();
  if (!(await myChildIds()).includes(input.studentId)) throw notFound('Student');
  await confirmFile(input.proofFile, 'payment_proof');
  let allocs: Allocation[];
  if (input.items?.length) {
    const invs: any[] = await Invoice.find({ _id: { $in: input.items.map((i) => i.invoiceId) }, studentId: input.studentId, status: { $in: ['issued', 'part_paid'] } }).lean();
    if (invs.length !== input.items.length) throw notFound('Invoice');
    allocs = input.items.map((i) => ({ invoiceId: i.invoiceId, studentId: input.studentId, amountKobo: i.amountKobo ?? invs.find((x) => String(x._id) === i.invoiceId).balanceKobo }));
  } else {
    allocs = allocateRoundAmount(input.amountKobo, await openInvoicesOf(input.studentId)).allocations;
  }
  const school: any = await loadSchool();
  const guardian: any = c.guardianId ? await Guardian.findById(c.guardianId).lean() : null;
  const payment: any = await Payment.create({
    reference: `PRF-${school.settings?.receiptPrefix ?? 'X'}-${randomCode(10)}`,
    channel: 'transfer',
    status: 'pending_confirmation',
    amountKobo: input.amountKobo,
    allocations: allocs,
    payerGuardianId: c.guardianId,
    payerName: fullName(guardian),
    bankReference: input.bankReference,
    paidOn: input.paidOn,
    proofFile: input.proofFile,
    note: input.note,
    recordedBy: c.userId,
    purpose: 'fees'
  });
  const student: any = await Student.findById(input.studentId).select('firstName lastName').lean();
  await notify({ event: 'proof_uploaded', to: (await staffRecipients(c.schoolId!, ['bursar', 'owner'])).map((r) => ({ ...r, kind: 'staff' as const })), vars: { parent: fullName(guardian), child: fullName(student), amount: `₦${formatKobo(input.amountKobo)}` } });
  await audit({ action: 'fees.proof.upload', entityType: 'payment', entityId: payment._id, after: { amountKobo: input.amountKobo } });
  return payment;
}

export async function listProofs() {
  const rows: any[] = await Payment.find({ status: 'pending_confirmation' }).sort({ createdAt: 1 }).lean();
  const sids = [...new Set(rows.flatMap((r) => r.allocations.map((a: any) => String(a.studentId))))];
  const students = new Map<string, any>((await Student.find({ _id: { $in: sids } }).select('firstName lastName admissionNumber').lean()).map((s: any) => [String(s._id), s]));
  return rows.map((r) => ({ id: String(r._id), amountKobo: r.amountKobo, paidOn: r.paidOn, bankReference: r.bankReference, proofFile: r.proofFile, note: r.note, payerName: r.payerName, students: [...new Set(r.allocations.map((a: any) => String(a.studentId)))].map((id: any) => ({ id, name: fullName(students.get(id)), admissionNumber: students.get(id)?.admissionNumber })), createdAt: r.createdAt }));
}

export async function confirmProof(id: string) {
  const c = me();
  const p0: any = await need(Payment.findById(id).lean(), 'Payment');
  assertTransition('payment', p0.status, 'successful', 'This proof');
  const out = await tx(async (session) => {
    const claimed: any = await Payment.findOneAndUpdate({ _id: id, status: 'pending_confirmation' }, { status: 'successful', confirmedBy: c.userId }, { new: true, session });
    if (!claimed) throw stateConflict('This proof was already decided.');
    const settled = await settleAllocations(claimed.allocations.map((a: any) => ({ invoiceId: String(a.invoiceId), studentId: String(a.studentId), amountKobo: a.amountKobo })), session);
    const leftover = claimed.amountKobo - sumKobo(settled.applied.map((a) => a.amountKobo));
    claimed.allocations = settled.applied;
    await claimed.save({ session });
    for (const iid of new Set(settled.applied.map((a) => a.invoiceId))) await recomputeInvoice(iid, session);
    const studentId = settled.applied[0]?.studentId ?? settled.leftoverStudentId ?? p0.allocations[0]?.studentId?.toString();
    if (leftover > 0 && studentId) await Credit.create([{ studentId, amountKobo: leftover, sourcePaymentId: claimed._id }], { session });
    const receipts = await createReceipts(claimed, { creditKobo: leftover, creditStudentId: studentId }, session);
    await audit({ action: 'fees.proof.confirm', entityType: 'payment', entityId: id, after: { amountKobo: claimed.amountKobo }, session });
    return { payment: claimed, receipts };
  });
  await afterPayment(out.payment, out.receipts);
  return out;
}

export async function rejectProof(id: string, reason: string) {
  const p: any = await need(Payment.findById(id), 'Payment');
  assertTransition('payment', p.status, 'rejected', 'This proof');
  p.status = 'rejected';
  p.rejectReason = reason;
  await p.save();
  await audit({ action: 'fees.proof.reject', entityType: 'payment', entityId: id, reason });
  const g: any = p.payerGuardianId ? await Guardian.findById(p.payerGuardianId).lean() : null;
  const sid = p.allocations[0]?.studentId;
  const student: any = sid ? await Student.findById(sid).select('firstName lastName').lean() : null;
  if (g) await notify({ event: 'proof_decided', to: [{ userId: g.userId ? String(g.userId) : undefined, phone: g.phone, email: g.email, kind: 'parent' }], vars: { child: fullName(student), decision: 'rejected', note: reason } });
  return p;
}

// ------------------------------------------------------------------ reversal and refund

async function assertNoPendingRequest(paymentId: string) {
  if (await Approval.exists({ type: { $in: ['reversal', 'refund'] }, status: 'pending', 'payload.paymentId': paymentId })) throw stateConflict('A request to reverse or refund this payment is already waiting for approval.');
}

export async function requestReversal(paymentId: string, reason: string) {
  const c = me();
  const p: any = await need(Payment.findById(paymentId).lean(), 'Payment');
  if (p.channel === 'paystack') throw stateConflict('This is an online payment. Ask for a refund instead.');
  if (p.channel === 'credit') throw stateConflict('A credit applied to an invoice cannot be reversed on its own.');
  assertTransition('payment', p.status, 'reversed', 'This payment');
  await assertNoPendingRequest(paymentId);
  const approval = await Approval.create({ type: 'reversal', payload: { paymentId, reference: p.reference, amountKobo: p.amountKobo }, summary: `Reverse payment ${p.reference}: ₦${formatKobo(p.amountKobo)}`, requestedBy: c.userId, reason });
  await audit({ action: 'fees.reversal.request', entityType: 'payment', entityId: paymentId, reason });
  return approval;
}

export async function requestRefund(paymentId: string, reason: string) {
  const c = me();
  const p: any = await need(Payment.findById(paymentId).lean(), 'Payment');
  if (p.channel !== 'paystack') throw stateConflict('This was not an online payment. Ask for a reversal instead.');
  assertTransition('payment', p.status, 'refunded', 'This payment');
  await assertNoPendingRequest(paymentId);
  const approval = await Approval.create({ type: 'refund', payload: { paymentId, reference: p.reference, amountKobo: p.amountKobo }, summary: `Refund payment ${p.reference}: ₦${formatKobo(p.amountKobo)}`, requestedBy: c.userId, reason });
  await audit({ action: 'fees.refund.request', entityType: 'payment', entityId: paymentId, reason });
  return approval;
}

/**
 * The payment is marked reversed or refunded, the invoice balances are restored, and the receipts are marked void.
 * The original receipt is marked void, not deleted. Void receipts still verify, and show as void.
 */
async function reversePayment(approval: any, status: 'reversed' | 'refunded', session: Session) {
  const p: any = await Payment.findById(approval.payload.paymentId).session(session ?? null);
  if (!p) throw notFound('Payment');
  assertTransition('payment', p.status, status, 'This payment');
  // Credit from this payment that was already applied to another invoice blocks the reversal.
  const credits: any[] = await Credit.find({ sourcePaymentId: p._id }).session(session ?? null);
  if (credits.some((cr) => cr.appliedInvoiceId)) throw stateConflict('The excess from this payment was already applied to another invoice. Reverse that first.');
  await Credit.deleteMany({ sourcePaymentId: p._id, appliedInvoiceId: { $exists: false } }, { session });
  p.status = status;
  p.reversal = { approvalId: approval._id, at: new Date(), reason: approval.reason, kind: status === 'refunded' ? 'refund' : 'reversal' };
  await p.save({ session });
  for (const id of new Set(p.allocations.map((a: any) => String(a.invoiceId)))) await recomputeInvoice(id, session);
  await Receipt.updateMany({ paymentId: p._id }, { voidedAt: new Date() }, { session });
  await audit({ action: `fees.payment.${status}`, entityType: 'payment', entityId: p._id, after: { amountKobo: p.amountKobo }, reason: approval.reason, session });
  return p;
}

export async function applyReversal(approval: any, session: Session) {
  const p = await reversePayment(approval, 'reversed', session);
  await afterReversal(p);
  return p;
}

/** Online refunds go through Paystack after approval. If that is not practical, the school pays the parent itself and records it here (manualRefund). */
export async function applyRefund(approval: any, manual: boolean) {
  const p0: any = await need(Payment.findById(approval.payload.paymentId).lean(), 'Payment');
  if (!manual) {
    try {
      await paystack().refund(p0.reference, p0.amountKobo + p0.chargeKobo);
    } catch (e) {
      throw new AppError('payment_provider_error', `${(e as Error).message} If the school pays the parent back itself, approve again and say the refund was made outside the platform.`);
    }
  }
  const p = await tx((session) => reversePayment(approval, 'refunded', session));
  await afterReversal(p);
  return p;
}

async function afterReversal(p: any) {
  const receipts: any[] = await Receipt.find({ paymentId: p._id }).lean();
  for (const r of receipts) await enqueue('generate-receipt-pdf', { receiptId: String(r._id) }, { schoolId: getCtx()?.schoolId });
  const g: any = p.payerGuardianId ? await Guardian.findById(p.payerGuardianId).lean() : null;
  if (g) await notify({ event: 'proof_decided', to: [{ userId: g.userId ? String(g.userId) : undefined, phone: g.phone, email: g.email, kind: 'parent' }], vars: { child: 'your child', decision: p.status, note: `Payment ${p.reference} was ${p.status}. Your invoice balance was restored.` } });
}

// ------------------------------------------------------------------ receipts

export async function receiptView(r: any) {
  const school: any = await loadSchool();
  const student: any = r.studentId ? await Student.findById(r.studentId).select('firstName lastName admissionNumber').lean() : null;
  return {
    id: String(r._id),
    number: r.number,
    paymentId: String(r.paymentId),
    studentId: r.studentId ? String(r.studentId) : undefined,
    student: student ? { name: fullName(student), admissionNumber: student.admissionNumber } : undefined,
    payerName: r.payerName,
    amountKobo: r.amountKobo,
    balanceAfterKobo: r.balanceAfterKobo,
    method: r.method,
    paidOn: r.paidOn,
    lines: r.lines,
    verificationCode: r.verificationCode,
    verifyUrl: schoolLink(school.slug, `/verify/${r.verificationCode}`),
    void: !!r.voidedAt,
    pdfReady: !!r.file,
    createdAt: r.createdAt
  };
}

/** Render the receipt PDF. Called by the job and on demand. A void receipt is rendered with a VOID mark. */
export async function renderReceipt(receiptId: string) {
  const r: any = await need(Receipt.findById(receiptId), 'Receipt');
  const school: any = await loadSchool();
  const student: any = r.studentId ? await Student.findById(r.studentId).select('firstName lastName admissionNumber').lean() : null;
  let className: string | undefined;
  if (r.studentId) {
    const session = await currentSession();
    const e: any = session ? await Enrolment.findOne({ studentId: r.studentId, sessionId: session._id }).lean() : null;
    if (e) className = (await classNames([String(e.classArmId)])).get(String(e.classArmId))?.name;
  }
  const payment: any = await Payment.findById(r.paymentId).select('reference').lean();
  const buf = await receiptPdf(
    { name: school.name, motto: school.motto, logoRef: school.branding?.logo, primary: school.branding?.primary, secondary: school.branding?.secondary, address: [school.address?.street, school.address?.town, school.address?.state].filter(Boolean).join(', '), phone: school.phone, email: school.email },
    {
      number: r.number,
      date: r.paidOn ?? lagosDate(r.createdAt),
      verificationCode: r.verificationCode,
      verifyUrl: schoolLink(school.slug, `/verify/${r.verificationCode}`),
      void: !!r.voidedAt,
      student: student ? { name: fullName(student), admissionNumber: student.admissionNumber, className } : undefined,
      payerName: r.payerName,
      method: r.method,
      lines: r.lines,
      amountKobo: r.amountKobo,
      balanceAfterKobo: r.balanceAfterKobo,
      reference: payment?.reference
    }
  );
  const ref = await saveGenerated(String(school._id), buf, 'application/pdf', 'pdf');
  r.file = ref;
  await r.save();
  return ref;
}

registerJob('generate-receipt-pdf', async ({ payload }) => ({ file: await renderReceipt(payload.receiptId) }));

/** Public verification page: the minimum needed to confirm a document is genuine (Document 3, section 13.1). */
export async function verifyCode(code: string) {
  const school: any = await loadSchool();
  const receipt: any = await Receipt.findOne({ verificationCode: code }).lean();
  if (receipt) {
    const student: any = receipt.studentId ? await Student.findById(receipt.studentId).select('firstName lastName').lean() : null;
    return { found: true, type: 'receipt', school: school.name, number: receipt.number, studentName: student ? fullName(student) : undefined, amountKobo: receipt.amountKobo, date: receipt.paidOn, status: receipt.voidedAt ? 'void' : 'valid' };
  }
  const tr: any = await TermResult.findOne({ verificationCode: code }).lean();
  if (tr) {
    const student: any = await Student.findById(tr.studentId).select('firstName lastName').lean();
    const term: any = await Term.findById(tr.termId).lean();
    const session: any = term ? await AcademicSession.findById(term.sessionId).lean() : null;
    return { found: true, type: 'report_card', school: school.name, studentName: fullName(student), term: term ? `Term ${term.number}, ${session?.name ?? ''}`.trim() : undefined, date: tr.reportCard?.generatedAt ? lagosDate(tr.reportCard.generatedAt) : undefined, status: tr.published ? (tr.revision > 0 ? 'valid' : 'valid') : 'void', revised: (tr.revision ?? 0) > 0 };
  }
  return { found: false };
}

// ------------------------------------------------------------------ webhooks

/**
 * Paystack calls the platform's webhook with charge.success. The handler checks the x-paystack-signature header (an HMAC
 * SHA-512 of the raw request body made with the secret key), stores the event, answers 200 at once and queues processing.
 */
export async function receiveWebhook(raw: Buffer | undefined, signature: string | undefined): Promise<{ accepted: boolean; duplicate?: boolean }> {
  if (!raw || !signature || !safeEqual(signWebhook(raw), signature)) throw new AppError('forbidden', 'The signature is not valid.');
  const body = JSON.parse(raw.toString('utf8'));
  const eventKey = `${body.event}:${body.data?.id ?? body.data?.reference ?? ''}`;
  try {
    const ev: any = await WebhookEvent.create({ provider: 'paystack', eventKey, type: body.event, payload: body, status: 'queued' });
    await enqueue('paystack-event', { eventId: String(ev._id) }, { uniqueKey: `paystack-event:${String(ev._id)}` });
    return { accepted: true };
  } catch (e: any) {
    if (e?.code === 11000) return { accepted: true, duplicate: true }; // delivered twice: the second is ignored
    throw e;
  }
}

registerJob('paystack-event', async ({ payload }) => {
  const ev: any = await asPlatform(() => WebhookEvent.findById(payload.eventId));
  if (!ev || ev.status === 'processed') return { ignored: true };
  try {
    const reference = ev.payload?.data?.reference;
    if (ev.type === 'charge.success' && reference) {
      const known = await asPlatform(() => Payment.exists({ reference }));
      if (!known) {
        await asPlatform(() => WebhookEvent.updateOne({ _id: ev._id }, { status: 'ignored', processedAt: new Date(), error: 'Unknown reference' }));
        return { ignored: true };
      }
      await verifyAndApply(reference);
    } else if (ev.type === 'charge.failed' && reference && (await asPlatform(() => Payment.exists({ reference })))) {
      await verifyAndApply(reference);
    }
    await asPlatform(() => WebhookEvent.updateOne({ _id: ev._id }, { status: 'processed', processedAt: new Date() }));
    return { processed: true };
  } catch (e) {
    await asPlatform(() => WebhookEvent.updateOne({ _id: ev._id }, { status: 'failed', error: (e as Error).message.slice(0, 300) }));
    throw e;
  }
});

/** Every 30 minutes: verify payments still "initiated" after 15 minutes, and mark them abandoned after 24 hours. */
registerJob('reconcile-payments', async () => {
  const cutoff = minutesFromNow(-15);
  const stuck: any[] = await asPlatform(() => Payment.find({ status: 'initiated', channel: 'paystack', createdAt: { $lt: cutoff } }).limit(500).lean());
  let completed = 0;
  let abandoned = 0;
  for (const p of stuck) {
    try {
      const r = await verifyAndApply(p.reference);
      if (r.applied) completed += 1;
    } catch {
      /* provider unreachable: try again next run */
    }
    if (Date.now() - new Date(p.createdAt).getTime() > 24 * 3600_000) {
      const res = await asPlatform(() => Payment.updateOne({ _id: p._id, status: 'initiated' }, { status: 'abandoned' }));
      abandoned += res.modifiedCount;
    }
  }
  return { checked: stuck.length, completed, abandoned };
});

// ------------------------------------------------------------------ bank account

export const listBanks = () => paystack().listBanks();

export async function resolveBank(bankCode: string, accountNumber: string) {
  return paystack().resolveAccount(bankCode, accountNumber);
}

/** Changing the settlement account needs the owner's SMS code. */
export async function requestBankCode() {
  const c = me();
  const user: any = await User.findById(c.userId).select('phone').lean();
  if (!user?.phone) throw validation('Your account has no phone number for a code.');
  const { code } = await createOtp(c.userId, 'bank_change');
  await sendCode({ phone: user.phone }, code);
  return { sent: true };
}

/**
 * The owner chooses the bank and enters the account number, the API resolves the account name, the owner confirms it,
 * and the API creates (or updates) the Paystack subaccount. Only the bank code, the last four digits and the account name
 * are stored. A change repeats these steps, needs the owner's SMS code, writes an audit record and notifies the super admin.
 */
export async function setBank(input: { bankCode: string; accountNumber: string; accountName: string; code?: string }) {
  const c = me();
  const school: any = await School.findById(c.schoolId);
  const changing = !!school.paystack?.subaccountCode;
  if (changing) {
    if (!input.code) throw validation('Enter the code we sent to your phone.', { code: 'Required to change the bank account.' });
    await requireOtp(c.userId, 'bank_change', input.code);
  }
  const resolved = await paystack().resolveAccount(input.bankCode, input.accountNumber);
  if (resolved.accountName.trim().toLowerCase() !== input.accountName.trim().toLowerCase()) throw validation('The account name does not match. Check the account number and the bank.', { accountName: 'Does not match the bank’s record.' });
  const banks = await paystack().listBanks().catch(() => []);
  const bankName = banks.find((b) => b.code === input.bankCode)?.name;

  let code = school.paystack?.subaccountCode;
  if (changing) await paystack().updateSubaccount(code, { businessName: school.name, bankCode: input.bankCode, accountNumber: input.accountNumber });
  else code = (await paystack().createSubaccount({ businessName: school.name, bankCode: input.bankCode, accountNumber: input.accountNumber })).subaccountCode;

  const before = { bankCode: school.paystack?.bankCode, accountLast4: school.paystack?.accountLast4, accountName: school.paystack?.accountName };
  school.paystack = { subaccountCode: code, bankCode: input.bankCode, accountLast4: input.accountNumber.slice(-4), accountName: resolved.accountName, bankName };
  await school.save();
  await audit({ action: 'fees.bank.change', entityType: 'school', entityId: school._id, before, after: { bankCode: input.bankCode, accountLast4: input.accountNumber.slice(-4), accountName: resolved.accountName } });

  const owners = await staffRecipients(String(school._id), ['owner'], 'owner');
  await notify({ schoolId: String(school._id), event: 'bank_changed', to: owners, vars: { account: `${resolved.accountName} (${input.accountNumber.slice(-4).padStart(10, '*')})` } });
  // The super admin is notified too.
  if (changing) await sendEmail(env.SUPER_ADMIN_EMAIL, `Bank account changed: ${school.name}`, `${school.name} changed its settlement account to ${resolved.accountName} ending ${input.accountNumber.slice(-4)}.`);
  return { configured: true, accountName: resolved.accountName, accountLast4: input.accountNumber.slice(-4), bankName };
}

export { forbidden, Membership, ClassArm, ClassLevel, files, portalLink, todayLagos, Allocation };
