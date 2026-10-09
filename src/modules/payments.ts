import crypto from 'node:crypto';
import { createRoutes } from '../core/route';
import { z, objectId, text, dateStr, kobo, pageQuery, idParam, name } from '../core/validate';
import { created, list, ok, Reply } from '../core/http';
import { can, me } from '../core/http';
import { getCtx } from '../core/context';
import { softAuthenticate } from '../core/auth';
import { AppError, notFound } from '../core/errors';
import { exportRows, paging } from '../core/pagination';
import { env, isLocal } from '../config/env';
import { files } from '../integrations/storage';
import { fakePaystack, usingFakePaystack } from '../integrations/paystack';
import { Guardian, MessageLog, Payment, Receipt, Student, Invoice } from '../models';
import { need, fullName, loadSchool } from '../services/common';
import { notify } from '../services/notify';
import { schoolLink } from '../lib/links';
import { formatKobo } from '../lib/money';
import { asPlatform } from '../core/context';
import * as pay from '../services/payments';
import { drainJobs } from '../jobs/queue';
import { myChildIds } from '../services/reach';

const r = createRoutes();
export const router = r.router;

const items = z.array(z.object({ invoiceId: objectId, amountKobo: kobo.refine((v) => v > 0, 'Enter an amount above zero.').optional() }).strict()).min(1).max(30);

// ------------------------------------------------------------------ parent: invoices, quote, checkout

r.get('/my/invoices', { access: { perm: 'fees.own.view' }, query: z.object({ studentId: objectId.optional() }).strict(), summary: 'Open and past invoices for the caller’s children' }, async (req) => {
  const kids = await myChildIds();
  const sid = (req.query as any).studentId;
  if (sid && !kids.includes(sid)) throw notFound('Student');
  const rows: any[] = await Invoice.find({ studentId: { $in: sid ? [sid] : kids }, status: { $ne: 'void' } }).sort({ createdAt: -1 }).lean();
  const students = new Map<string, any>((await Student.find({ _id: { $in: kids } }).select('firstName lastName admissionNumber').lean()).map((s: any) => [String(s._id), s]));
  const today = new Date().toISOString().slice(0, 10);
  return ok(rows.map((x) => ({ id: String(x._id), number: x.number, kind: x.kind, status: x.status, studentId: String(x.studentId), student: fullName(students.get(String(x.studentId))), lines: x.lines, discounts: x.discounts, totalKobo: x.totalKobo, paidKobo: x.paidKobo, balanceKobo: x.balanceKobo, dueOn: x.dueOn, overdue: !!x.dueOn && x.dueOn < today && x.balanceKobo > 0, termId: x.termId ? String(x.termId) : undefined })));
});

r.post('/payments/quote', { access: { perm: 'fees.pay' }, body: z.object({ items }).strict(), summary: 'Given chosen invoices or amounts, return the fee total, charge and amount to pay' }, async (req) => ok(await pay.quotePayment(req.body.items)));

r.post('/payments/checkout', { access: { perm: 'fees.pay' }, idem: true, requireActive: true, body: z.object({ items }).strict(), summary: 'Create the payment and return the Paystack authorization URL' }, async (req) => created(await pay.checkout(req.body.items)));

/**
 * Called by the callback page. Public, because the parent may land back signed out. It runs the same verify-and-apply
 * function as the webhook, so the parent sees the result even if the webhook is slow. Receipts are returned only to the payer.
 */
r.get('/payments/verify', { access: 'public', host: true, rate: { name: 'pay-verify', windowMs: 60_000, max: 60 }, query: z.object({ reference: z.string().min(8).max(80) }).strict(), summary: 'Verify and apply a payment by reference' }, async (req) => {
  const reference = (req.query as any).reference as string;
  const existing: any = await Payment.findOne({ reference }).lean(); // scoped to the school of this host
  if (!existing) throw notFound('Payment');
  const out = await pay.verifyAndApply(reference);
  const signedIn = await softAuthenticate(req, (req as any).hostInfo);
  const payer = signedIn && !!getCtx()?.guardianId && String(out.payment.payerGuardianId ?? '') === getCtx()!.guardianId;
  const body: any = { status: out.payment.status, amountKobo: out.payment.amountKobo, purpose: out.payment.purpose, flagged: !!out.payment.flagged };
  if (payer) body.receipts = await Promise.all(out.receipts.map((x: any) => pay.receiptView(x)));
  else if (out.payment.status === 'successful') body.receiptCount = out.receipts.length;
  return ok(body);
});

// ------------------------------------------------------------------ bursar: offline payments, proofs

r.post(
  '/payments/offline',
  {
    access: { perm: 'fees.payment.record' },
    idem: true,
    body: z.object({
      studentId: objectId,
      amountKobo: kobo.refine((v) => v > 0, 'Enter an amount above zero.'),
      channel: z.enum(['cash', 'bank', 'pos', 'transfer']),
      paidOn: dateStr,
      bankReference: text(60).optional(),
      proofFile: z.string().max(300).optional(),
      allocations: z.array(z.object({ invoiceId: objectId, amountKobo: kobo.refine((v) => v > 0) }).strict()).max(30).optional(),
      note: text(300).optional(),
      confirmDuplicate: z.boolean().optional()
    }).strict(),
    summary: 'Record a cash, bank, POS or transfer payment'
  },
  async (req) => created(await pay.recordOffline(req.body))
);

r.post(
  '/payments/proofs',
  {
    access: { perm: 'fees.pay' },
    idem: true,
    body: z.object({ studentId: objectId, amountKobo: kobo.refine((v) => v > 0, 'Enter an amount above zero.'), paidOn: dateStr, bankReference: text(60).optional(), proofFile: z.string().min(10).max(300), items: items.optional(), note: text(300).optional() }).strict(),
    summary: 'Parent submits proof of an offline payment'
  },
  async (req) => {
    const p = await pay.uploadProof(req.body);
    return created({ id: String(p._id), status: p.status });
  }
);

r.get('/payments/proofs', { access: { perm: 'fees.payment.confirm_proof' }, summary: 'Proofs waiting for confirmation' }, async () => ok(await pay.listProofs()));

r.post('/payments/proofs/:id/confirm', { access: { perm: 'fees.payment.confirm_proof' }, idem: true, params: idParam, summary: 'Confirm a proof. Applies the payment and issues receipts' }, async (req) => {
  const out = await pay.confirmProof(req.params.id as string);
  return ok({ paymentId: String(out.payment._id), receipts: out.receipts.map((x: any) => ({ id: String(x._id), number: x.number })) });
});

r.post('/payments/proofs/:id/reject', { access: { perm: 'fees.payment.confirm_proof' }, params: idParam, body: z.object({ reason: text(300).min(3, 'Tell the parent why.') }).strict(), summary: 'Reject a proof with a reason' }, async (req) => {
  const p = await pay.rejectProof(req.params.id as string, req.body.reason);
  return ok({ id: String(p._id), status: p.status });
});

// ------------------------------------------------------------------ payments list and one payment

const paymentRow = (p: any, students: Map<string, any>) => ({
  id: String(p._id),
  reference: p.reference,
  channel: p.channel,
  status: p.status,
  amountKobo: p.amountKobo,
  chargeKobo: p.chargeKobo,
  commissionKobo: p.commissionKobo,
  payerName: p.payerName,
  students: [...new Set(p.allocations.map((a: any) => String(a.studentId)))].map((id: any) => ({ id, name: fullName(students.get(id)) })),
  paidOn: p.paidOn ?? p.provider?.paidAt ?? p.createdAt,
  bankReference: p.bankReference,
  flagged: !!p.flagged,
  flagReason: p.flagReason,
  purpose: p.purpose,
  createdAt: p.createdAt
});

r.get(
  '/payments',
  { access: { perm: 'fees.payment.view' }, query: z.object({ ...pageQuery, status: z.enum(['initiated', 'successful', 'failed', 'abandoned', 'pending_confirmation', 'rejected', 'reversed', 'refunded']).optional(), channel: z.enum(['paystack', 'cash', 'bank', 'pos', 'transfer', 'credit']).optional(), studentId: objectId.optional(), flagged: z.enum(['true']).optional(), from: dateStr.optional(), to: dateStr.optional() }).strict(), summary: 'List payments with filters' },
  async (req) => {
    const q = req.query as any;
    const filter: any = {};
    if (q.status) filter.status = q.status;
    if (q.channel) filter.channel = q.channel;
    if (q.studentId) filter['allocations.studentId'] = q.studentId;
    if (q.flagged) filter.flagged = true;
    if (q.q) filter.$or = [{ reference: new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { bankReference: new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { payerName: new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
    if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: new Date(`${q.from}T00:00:00+01:00`) } : {}), ...(q.to ? { $lte: new Date(`${q.to}T23:59:59+01:00`) } : {}) };
    const p = paging(q, ['createdAt', 'amountKobo', 'status'], '-createdAt');
    const [rows, total] = await Promise.all([Payment.find(filter).sort(p.sort).skip(q.format ? 0 : p.skip).limit(q.format ? 5000 : p.limit).lean(), Payment.countDocuments(filter)]);
    const sids = [...new Set(rows.flatMap((x: any) => x.allocations.map((a: any) => String(a.studentId))))];
    const students = new Map<string, any>((await Student.find({ _id: { $in: sids } }).select('firstName lastName').lean()).map((s: any) => [String(s._id), s]));
    const data = rows.map((x: any) => paymentRow(x, students));
    if (q.format) {
      return ok(
        await exportRows(
          'payments',
          [
            { header: 'Reference', value: (x: any) => x.reference },
            { header: 'Date', value: (x: any) => new Date(x.paidOn).toISOString().slice(0, 10) },
            { header: 'Channel', value: (x: any) => x.channel },
            { header: 'Status', value: (x: any) => x.status },
            { header: 'Payer', value: (x: any) => x.payerName },
            { header: 'Amount (kobo)', value: (x: any) => x.amountKobo }
          ],
          data,
          q.format
        )
      );
    }
    return list(data, { page: p.page, limit: p.limit, total });
  }
);

r.get('/payments/:id', { access: { perm: ['fees.payment.view', 'fees.own.view'] }, params: idParam, summary: 'One payment with allocations and receipts' }, async (req) => {
  const p: any = await need(Payment.findById(req.params.id).lean(), 'Payment');
  if (!can('fees.payment.view')) {
    const kids = await myChildIds();
    if (!p.allocations.some((a: any) => kids.includes(String(a.studentId)))) throw notFound('Payment');
  }
  const students = new Map<string, any>((await Student.find({ _id: { $in: p.allocations.map((a: any) => a.studentId) } }).select('firstName lastName').lean()).map((s: any) => [String(s._id), s]));
  const receipts = await Receipt.find({ paymentId: p._id }).lean();
  return ok({ ...paymentRow(p, students), allocations: p.allocations, reversal: p.reversal, proofFile: can('fees.payment.view') ? p.proofFile : undefined, receipts: await Promise.all(receipts.map((x: any) => pay.receiptView(x))) });
});

r.post('/payments/:id/reversal-request', { access: { perm: 'fees.refund.request' }, params: idParam, body: z.object({ reason: text(300).min(3, 'Give a reason.') }).strict(), summary: 'Ask to reverse an offline payment' }, async (req) => {
  const a = await pay.requestReversal(req.params.id as string, req.body.reason);
  return created({ approvalId: String(a._id), status: 'pending' });
});
r.post('/payments/:id/refund-request', { access: { perm: 'fees.refund.request' }, params: idParam, body: z.object({ reason: text(300).min(3, 'Give a reason.') }).strict(), summary: 'Ask to refund an online payment' }, async (req) => {
  const a = await pay.requestRefund(req.params.id as string, req.body.reason);
  return created({ approvalId: String(a._id), status: 'pending' });
});

// ------------------------------------------------------------------ receipts

r.get(
  '/receipts',
  { access: { perm: 'fees.payment.view' }, query: z.object({ ...pageQuery, studentId: objectId.optional(), from: dateStr.optional(), to: dateStr.optional() }).strict(), summary: 'List receipts' },
  async (req) => {
    const q = req.query as any;
    const filter: any = {};
    if (q.studentId) filter.studentId = q.studentId;
    if (q.q) filter.number = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: new Date(`${q.from}T00:00:00+01:00`) } : {}), ...(q.to ? { $lte: new Date(`${q.to}T23:59:59+01:00`) } : {}) };
    const p = paging(q, ['createdAt', 'number', 'amountKobo'], '-createdAt');
    const [rows, total] = await Promise.all([Receipt.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), Receipt.countDocuments(filter)]);
    return list(await Promise.all(rows.map((x: any) => pay.receiptView(x))), { page: p.page, limit: p.limit, total });
  }
);

r.get('/my/receipts', { access: { perm: 'fees.own.view' }, summary: 'Receipts for the caller’s children' }, async () => {
  const kids = await myChildIds();
  const rows = await Receipt.find({ studentId: { $in: kids } }).sort({ createdAt: -1 }).limit(200).lean();
  return ok(await Promise.all(rows.map((x: any) => pay.receiptView(x))));
});

async function receiptFor(id: string) {
  const rec: any = await need(Receipt.findById(id), 'Receipt');
  if (!can('fees.payment.view')) {
    if (!rec.studentId || !(await myChildIds()).includes(String(rec.studentId))) throw notFound('Receipt');
  }
  return rec;
}

r.get('/receipts/:id', { access: { perm: ['fees.payment.view', 'fees.own.view'] }, params: idParam, summary: 'One receipt as data' }, async (req) => ok(await pay.receiptView(await receiptFor(req.params.id as string))));

r.get('/receipts/:id/pdf', { access: { perm: ['fees.payment.view', 'fees.own.view'] }, params: idParam, summary: 'Link to the receipt PDF' }, async (req) => {
  const rec = await receiptFor(req.params.id as string);
  // The receipt is viewable as a web page at once. The PDF is made by the worker, and rendered now if it is not ready yet.
  const ref = rec.file && !rec.voidedAt ? rec.file : await pay.renderReceipt(String(rec._id));
  return ok({ url: files.link(ref, 300), expiresIn: 300 });
});

r.post('/receipts/:id/resend', { access: { perm: 'fees.payment.view' }, params: idParam, summary: 'Send the receipt to the parent again' }, async (req) => {
  const rec = await receiptFor(req.params.id as string);
  const payment: any = await Payment.findById(rec.paymentId).lean();
  const school: any = await loadSchool();
  const guardian: any = payment?.payerGuardianId ? await Guardian.findById(payment.payerGuardianId).lean() : null;
  const student: any = rec.studentId ? await Student.findById(rec.studentId).lean() : null;
  if (guardian) await notify({ event: 'payment_success', to: [{ userId: guardian.userId ? String(guardian.userId) : undefined, phone: guardian.phone, email: guardian.email, kind: 'parent' }], vars: { child: fullName(student), amount: `₦${formatKobo(rec.amountKobo)}`, receipt: rec.number, link: schoolLink(school.slug, `/verify/${rec.verificationCode}`) } });
  return ok({ sent: !!guardian });
});

// ------------------------------------------------------------------ bank account

r.get('/banks', { access: { perm: 'fees.bank.manage' }, summary: 'Paystack’s list of banks' }, async () => ok(await pay.listBanks()));

r.post('/school/bank/resolve', { access: { perm: 'fees.bank.manage' }, body: z.object({ bankCode: z.string().min(2).max(10), accountNumber: z.string().regex(/^\d{10}$/, 'Enter the 10 digit account number.') }).strict(), summary: 'Look up the account name for a bank and account number' }, async (req) => ok(await pay.resolveBank(req.body.bankCode, req.body.accountNumber)));

r.post('/school/bank/request-code', { access: { perm: 'fees.bank.manage' }, rate: { name: 'bank-code', windowMs: 60 * 60_000, max: 5 }, summary: 'Send the owner an SMS code to authorise a change' }, async () => ok(await pay.requestBankCode()));

r.put(
  '/school/bank',
  { access: { perm: 'fees.bank.manage' }, fresh: true, body: z.object({ bankCode: z.string().min(2).max(10), accountNumber: z.string().regex(/^\d{10}$/, 'Enter the 10 digit account number.'), accountName: name(120), code: z.string().regex(/^\d{6}$/).optional() }).strict(), summary: 'Set or change the settlement account, with the code' },
  async (req) => ok(await pay.setBank(req.body))
);

// ------------------------------------------------------------------ public verification page

r.get('/public/verify/:code', { access: 'public', host: true, rate: { name: 'verify', windowMs: 60_000, max: 40 }, params: z.object({ code: z.string().regex(/^[A-Z0-9]{8,16}$/i) }).strict(), summary: 'Check a receipt or report card code' }, async (req) => ok(await pay.verifyCode((req.params.code as string).toUpperCase())));

// ------------------------------------------------------------------ webhooks

r.post('/webhooks/paystack', { access: 'webhook', summary: 'Paystack events. Signature checked on the raw body' }, async (req) => {
  await pay.receiveWebhook((req as any).rawBody, req.header('x-paystack-signature'));
  return new Reply(200, { data: { received: true } });
});

const webhookToken = (provider: string) => crypto.createHash('sha256').update(`${env.JWT_SUPPORT_SECRET}:${provider}`).digest('hex').slice(0, 32);

/** Delivery reports from the SMS and email providers update the message log. The provider calls with ?token=... */
const deliveryBody = z.object({ message_id: z.string().optional(), ref: z.string().optional(), id: z.string().optional(), status: z.string().max(40) }).passthrough();
for (const provider of ['sms', 'email'] as const) {
  r.post(`/webhooks/${provider}`, { access: 'webhook', query: z.object({ token: z.string() }).strict(), body: deliveryBody, summary: `Delivery reports from the ${provider} provider` }, async (req) => {
    if ((req.query as any).token !== webhookToken(provider)) throw new AppError('forbidden', 'Not allowed.');
    const b = req.body as any;
    const ref = b.message_id ?? b.ref ?? b.id;
    const status = /deliver/i.test(b.status) ? 'delivered' : /fail|bounce|reject/i.test(b.status) ? 'failed' : 'sent';
    if (ref) {
      await asPlatform(() => MessageLog.updateMany({ providerRef: ref }, { status }));
    }
    return new Reply(200, { data: { received: true } });
  });
}
export { webhookToken };

// ------------------------------------------------------------------ local development: the "customer pays" button

if (isLocal && usingFakePaystack()) {
  r.post('/dev/paystack/simulate', { access: 'public', body: z.object({ reference: z.string().min(8), amountKobo: z.number().int().positive().optional(), status: z.enum(['success', 'failed']).optional() }).strict(), summary: 'Local only: the customer pays on the fake Paystack page' }, async (req) => {
    const sim = fakePaystack.simulatePay(req.body.reference, { amountKobo: req.body.amountKobo, status: req.body.status });
    await pay.receiveWebhook(Buffer.from(sim.body), sim.signature);
    await drainJobs();
    return ok({ simulated: true });
  });
}

export { me };
