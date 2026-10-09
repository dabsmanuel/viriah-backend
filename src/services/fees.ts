import type { ClientSession } from 'mongoose';
import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { nextInvoiceNumber } from '../core/counters';
import { sess, tx } from '../core/db';
import { forbidden, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { me } from '../core/http';
import { addDays, todayLagos } from '../lib/dates';
import { sumKobo } from '../lib/money';
import { discountAmount, invoiceBalance, invoiceStatus, invoiceTotal } from '../calc/fees';
import { enqueue, registerJob } from '../jobs/queue';
import { Approval, ClassLevel, Credit, Enrolment, FeeItem, FeeStructure, Guardian, Invoice, Payment, Receipt, Student, StudentGuardian, Term } from '../models';
import { classNames, enrolHooks } from './students';
import { fullName, need } from './common';
import { currentSession, resolveTerm } from './reach';
import { notify } from './notify';
import { schoolLink } from '../lib/links';
import { loadSchool } from './common';
import { formatKobo } from '../lib/money';
import { assertTermOpen } from './academics';

/** Fee setup, invoices, discounts and balances (FEE-01 to FEE-04, FEE-09, FEE-10, LEG-03). Money is whole kobo. */

// ------------------------------------------------------------------ recompute

/**
 * paidKobo is always recomputed from the payments, inside the same database transaction that changes a payment.
 * It is never adjusted by adding or subtracting.
 */
export async function recomputeInvoice(invoiceId: unknown, session?: ClientSession) {
  const inv: any = await Invoice.findById(invoiceId).session(session ?? null);
  if (!inv) throw notFound('Invoice');
  const pays: any[] = await Payment.find({ 'allocations.invoiceId': inv._id, status: 'successful' }).session(session ?? null).lean();
  const paid = sumKobo(pays.flatMap((p) => p.allocations.filter((a: any) => String(a.invoiceId) === String(inv._id)).map((a: any) => a.amountKobo)));
  inv.totalKobo = invoiceTotal(inv.lines, inv.discounts, inv.adjustments);
  inv.paidKobo = paid;
  inv.balanceKobo = invoiceBalance(inv.totalKobo, paid);
  if (inv.status !== 'void' && inv.status !== 'draft') inv.status = invoiceStatus(inv.totalKobo, paid, inv.status);
  await inv.save({ session });
  return inv;
}

/** Everything the student still owes across live invoices. */
export async function studentBalance(studentId: unknown, session?: ClientSession): Promise<number> {
  const invs: any[] = await Invoice.find({ studentId, status: { $in: ['issued', 'part_paid'] } }).session(session ?? null).select('balanceKobo').lean();
  return sumKobo(invs.map((i) => i.balanceKobo));
}

// ------------------------------------------------------------------ fee items and structures

export async function createFeeItem(input: { name: string; optional?: boolean }) {
  if (await FeeItem.exists({ name: input.name })) throw validation('This fee item already exists.', { name: 'Already exists.' });
  const item = await FeeItem.create(input);
  await audit({ action: 'fees.item.create', entityType: 'feeItem', entityId: item._id, after: input });
  return item;
}

export async function updateFeeItem(id: string, patch: { name?: string; optional?: boolean; active?: boolean }) {
  const item: any = await need(FeeItem.findById(id), 'Fee item');
  if (patch.name && patch.name !== item.name && (await FeeItem.exists({ name: patch.name, _id: { $ne: id } }))) throw validation('This fee item already exists.', { name: 'Already exists.' });
  const before = { name: item.name, optional: item.optional, active: item.active };
  Object.assign(item, patch);
  await item.save();
  await audit({ action: 'fees.item.update', entityType: 'feeItem', entityId: id, before, after: patch });
  return item;
}

export async function feeStructures(termId: string | undefined, classLevelId?: string) {
  const term = await resolveTerm(termId);
  const rows: any[] = await FeeStructure.find({ termId: term._id, ...(classLevelId ? { classLevelId } : {}) }).lean();
  return { termId: String(term._id), structures: rows.map((r) => ({ id: String(r._id), classLevelId: String(r.classLevelId), lines: r.lines.map((l: any) => ({ feeItemId: String(l.feeItemId), amountKobo: l.amountKobo })), totalKobo: sumKobo(r.lines.map((l: any) => l.amountKobo)) })) };
}

export async function setFeeStructure(termId: string, classLevelId: string, lines: Array<{ feeItemId: string; amountKobo: number }>) {
  await need(Term.findById(termId).lean(), 'Term');
  await need(ClassLevel.findById(classLevelId).lean(), 'Class level');
  const ids = lines.map((l) => l.feeItemId);
  if (new Set(ids).size !== ids.length) throw validation('A fee item is listed twice.', { lines: 'Duplicate item.' });
  if ((await FeeItem.countDocuments({ _id: { $in: ids } })) !== ids.length) throw notFound('Fee item');
  const before: any = await FeeStructure.findOne({ termId, classLevelId }).lean();
  const doc = await FeeStructure.findOneAndUpdate({ termId, classLevelId }, { $set: { lines: lines.filter((l) => l.amountKobo > 0) } }, { upsert: true, new: true });
  await audit({ action: 'fees.structure.update', entityType: 'feeStructure', entityId: doc._id, before: before?.lines, after: lines });
  return doc;
}

export async function copyFeeStructure(fromTermId: string, toTermId: string) {
  await need(Term.findById(toTermId).lean(), 'Term');
  const rows: any[] = await FeeStructure.find({ termId: fromTermId }).lean();
  if (!rows.length) throw validation('The term you are copying from has no fee structure.', { fromTermId: 'Nothing to copy.' });
  let copied = 0;
  for (const r of rows) {
    const res = await FeeStructure.updateOne({ termId: toTermId, classLevelId: r.classLevelId }, { $setOnInsert: { termId: toTermId, classLevelId: r.classLevelId, lines: r.lines } }, { upsert: true });
    if (res.upsertedCount) copied += 1;
  }
  await audit({ action: 'fees.structure.copy', entityType: 'term', entityId: toTermId, after: { fromTermId, copied } });
  return { copied };
}

// ------------------------------------------------------------------ invoices

/** The compulsory items of a level's structure. Optional items are added per student. */
async function compulsoryLines(termId: unknown, classLevelId: unknown, session?: ClientSession) {
  const structure: any = await FeeStructure.findOne({ termId, classLevelId }).session(session ?? null).lean();
  if (!structure) return null;
  const items = new Map<string, any>((await FeeItem.find({ _id: { $in: structure.lines.map((l: any) => l.feeItemId) } }).session(session ?? null).lean()).map((i: any) => [String(i._id), i]));
  return structure.lines
    .filter((l: any) => !items.get(String(l.feeItemId))?.optional)
    .map((l: any) => ({ feeItemId: l.feeItemId, label: items.get(String(l.feeItemId))?.name ?? 'Fee', amountKobo: l.amountKobo, optional: false }));
}

/** Overpayments held as credit are applied automatically when the next invoice is issued. */
export async function applyCredits(invoice: any, session?: ClientSession) {
  if (!invoice.studentId || invoice.balanceKobo <= 0) return invoice;
  const credits: any[] = await Credit.find({ studentId: invoice.studentId, appliedInvoiceId: { $exists: false } }).sort({ createdAt: 1 }).session(session ?? null);
  let left = invoice.balanceKobo;
  const allocations: any[] = [];
  for (const c of credits) {
    if (left <= 0) break;
    const use = Math.min(left, c.amountKobo);
    if (use <= 0) continue;
    if (use === c.amountKobo) {
      c.appliedInvoiceId = invoice._id;
      c.appliedAt = new Date();
      await c.save({ session });
    } else {
      // Split: the part used is applied, the rest stays as credit.
      await Credit.create([{ studentId: c.studentId, amountKobo: c.amountKobo - use, sourcePaymentId: c.sourcePaymentId }], { session });
      c.amountKobo = use;
      c.appliedInvoiceId = invoice._id;
      c.appliedAt = new Date();
      await c.save({ session });
    }
    allocations.push({ invoiceId: invoice._id, studentId: invoice.studentId, amountKobo: use });
    left -= use;
  }
  if (allocations.length) {
    const reference = `CR-${invoice.number}-${Date.now().toString(36)}`.toUpperCase();
    await Payment.create([{ reference, channel: 'credit', status: 'successful', amountKobo: sumKobo(allocations.map((a) => a.amountKobo)), allocations, note: 'Credit applied to a new invoice', recordedBy: getCtx()?.userId, purpose: 'fees' }], { session });
    return recomputeInvoice(invoice._id, session);
  }
  return invoice;
}

export interface NewInvoice {
  studentId?: string;
  termId?: string;
  kind: 'term' | 'admission' | 'application' | 'opening_balance' | 'single';
  lines: Array<{ feeItemId?: unknown; label: string; amountKobo: number; optional?: boolean }>;
  dueOn?: string;
  applicationId?: string;
  payerName?: string;
  payerPhone?: string;
  importBatchId?: string;
  status?: 'issued' | 'draft';
}

export async function createInvoice(input: NewInvoice, session?: ClientSession) {
  if (!input.lines.length) throw validation('An invoice needs at least one line.', { lines: 'Add a line.' });
  const number = await nextInvoiceNumber(session);
  const total = invoiceTotal(input.lines, [], []);
  const [inv] = await Invoice.create(
    [{ number, studentId: input.studentId, termId: input.termId, kind: input.kind, lines: input.lines, totalKobo: total, paidKobo: 0, balanceKobo: total, dueOn: input.dueOn, status: input.status ?? 'issued', issuedAt: new Date(), applicationId: input.applicationId, payerName: input.payerName, payerPhone: input.payerPhone, importBatchId: input.importBatchId }],
    { session }
  );
  return input.kind === 'term' || input.kind === 'single' ? applyCredits(inv, session) : inv;
}

/** A student enrolled mid-term gets a single invoice at enrolment, from the term's structure (F6, F8). */
export async function invoiceStudentForCurrentTerm(student: any, enrolment: any, session?: ClientSession) {
  const term: any = await Term.findOne({ status: 'current' }).session(session ?? null).lean();
  if (!term) return null;
  if (!(await Invoice.exists({ termId: term._id, kind: 'term', status: { $ne: 'void' } }))) return null; // invoices for the term have not been generated yet
  if (await Invoice.exists({ studentId: student._id, termId: term._id, kind: 'term', status: { $ne: 'void' } })) return null;
  const lines = await compulsoryLines(term._id, enrolment.classLevelId, session);
  if (!lines?.length) return null;
  return createInvoice({ studentId: String(student._id), termId: String(term._id), kind: 'term', lines, dueOn: term.startDate }, session);
}
enrolHooks.invoice = async (student, enrolment, session) => {
  await invoiceStudentForCurrentTerm(student, enrolment, session);
};

/** Create invoices for a term for all active students, or chosen levels. Safe to run twice: a student with a live term invoice is skipped. */
export async function generateInvoicesFor(termId: string, classLevelIds?: string[], regenerateUnpaid = false, progress?: (n: number) => Promise<void>) {
  const term: any = await need(Term.findById(termId).lean(), 'Term');
  await assertTermOpen(termId);
  const enrolments: any[] = await Enrolment.find({ sessionId: term.sessionId, ...(classLevelIds?.length ? { classLevelId: { $in: classLevelIds } } : {}) }).lean();
  const students = new Map<string, any>((await Student.find({ _id: { $in: enrolments.map((e) => e.studentId) }, status: 'active' }).lean()).map((s: any) => [String(s._id), s]));
  const structures = new Map<string, any[] | null>();
  const result = { created: 0, skipped: 0, regenerated: 0, noStructure: 0 };
  let i = 0;
  for (const e of enrolments) {
    i += 1;
    if (progress && i % 25 === 0) await progress((i / enrolments.length) * 90);
    const student = students.get(String(e.studentId));
    if (!student) continue;
    const key = String(e.classLevelId);
    if (!structures.has(key)) structures.set(key, await compulsoryLines(termId, e.classLevelId));
    const lines = structures.get(key);
    if (!lines?.length) {
      result.noStructure += 1;
      continue;
    }
    const existing: any = await Invoice.findOne({ studentId: student._id, termId, kind: 'term', status: { $ne: 'void' } });
    if (existing) {
      // A fee amount changed after invoices were generated: unpaid invoices can be regenerated. Invoices with payments are adjusted by an explicit line, never silently.
      if (regenerateUnpaid) {
        const optional = existing.lines.filter((l: any) => l.optional);
        const newTotal = invoiceTotal([...lines, ...optional], []);
        const oldBase = invoiceTotal(existing.lines, []);
        if (existing.paidKobo === 0 && existing.status === 'issued') {
          existing.lines = [...lines, ...optional];
          await existing.save();
          await recomputeInvoice(existing._id);
          result.regenerated += 1;
        } else if (newTotal !== oldBase) {
          existing.adjustments.push({ label: 'Fee structure change', amountKobo: newTotal - oldBase, at: new Date(), by: getCtx()?.userId });
          await existing.save();
          await recomputeInvoice(existing._id);
          result.regenerated += 1;
        } else result.skipped += 1;
      } else result.skipped += 1;
      continue;
    }
    await tx(async (session) => {
      await createInvoice({ studentId: String(student._id), termId, kind: 'term', lines, dueOn: term.startDate }, session);
    });
    result.created += 1;
  }
  return result;
}

registerJob('generate-invoices', async ({ payload, progress }) => {
  const result = await generateInvoicesFor(payload.termId, payload.classLevelIds, !!payload.regenerateUnpaid, progress);
  await audit({ action: 'fees.invoices.generate', entityType: 'term', entityId: payload.termId, after: result });
  // Parents are told the invoice is ready, with the amount and a link to pay.
  if (result.created) await enqueue('notify-invoices', { termId: payload.termId }, { schoolId: getCtx()?.schoolId, uniqueKey: `notify-invoices:${getCtx()?.schoolId}:${payload.termId}:${Date.now()}` });
  return result;
});

registerJob('notify-invoices', async ({ payload, schoolId }) => {
  const school: any = await loadSchool(schoolId);
  const term: any = await Term.findById(payload.termId).lean();
  const invoices: any[] = await Invoice.find({ termId: payload.termId, kind: 'term', status: 'issued', paidKobo: 0 }).lean();
  let sent = 0;
  for (const inv of invoices) {
    const links: any[] = await StudentGuardian.find({ studentId: inv.studentId, isFeePayer: true, access: { $ne: 'none' } }).lean();
    const guardians: any[] = await Guardian.find({ _id: { $in: links.map((l) => l.guardianId) } }).lean();
    const student: any = await Student.findById(inv.studentId).lean();
    await notify({
      schoolId,
      event: 'invoice_issued',
      to: guardians.map((g) => ({ userId: g.userId ? String(g.userId) : undefined, phone: g.phone, email: g.email, name: fullName(g), kind: 'parent' as const })),
      vars: { child: fullName(student), amount: `₦${formatKobo(inv.balanceKobo)}`, term: `term ${term?.number ?? ''}`, link: schoolLink(school.slug, '/portal/parent/fees') }
    });
    sent += 1;
  }
  return { sent };
});

export async function startInvoiceGeneration(termId: string, classLevelIds?: string[], regenerateUnpaid = false) {
  const c = me();
  await assertTermOpen(termId);
  const key = `invoices:${c.schoolId}:${termId}:${(classLevelIds ?? ['all']).sort().join(',')}:${regenerateUnpaid ? 'regen' : 'new'}:${todayLagos()}`;
  return enqueue('generate-invoices', { termId, classLevelIds, regenerateUnpaid }, { schoolId: c.schoolId, userId: c.userId, uniqueKey: regenerateUnpaid ? undefined : key });
}

export async function raiseSingleInvoice(input: { studentId: string; termId?: string; lines: Array<{ feeItemId?: string; label?: string; amountKobo: number }>; dueOn?: string }) {
  await need(Student.findById(input.studentId).select('_id').lean(), 'Student');
  const items = new Map<string, any>((await FeeItem.find({ _id: { $in: input.lines.map((l) => l.feeItemId).filter(Boolean) } }).lean()).map((i: any) => [String(i._id), i]));
  const lines = input.lines.map((l) => {
    const item = l.feeItemId ? items.get(l.feeItemId) : null;
    if (l.feeItemId && !item) throw notFound('Fee item');
    const label = l.label ?? item?.name;
    if (!label) throw validation('Give each line a label or a fee item.', { lines: 'Needs a label.' });
    return { feeItemId: item?._id, label, amountKobo: l.amountKobo, optional: !!item?.optional };
  });
  if (input.termId) await assertTermOpen(input.termId);
  const inv = await tx((s) => createInvoice({ studentId: input.studentId, termId: input.termId, kind: 'single', lines, dueOn: input.dueOn }, s));
  await audit({ action: 'fees.invoice.create', entityType: 'invoice', entityId: inv._id, after: { number: inv.number, totalKobo: inv.totalKobo } });
  return inv;
}

/** Add lines, or remove lines that payments do not cover. Lines covered by payments cannot be removed. */
export async function editInvoice(id: string, patch: { addLines?: Array<{ feeItemId?: string; label?: string; amountKobo: number }>; removeIndexes?: number[]; dueOn?: string }) {
  const inv: any = await need(Invoice.findById(id), 'Invoice');
  if (inv.status === 'void') throw stateConflict('This invoice is void.');
  const before = { totalKobo: inv.totalKobo, lines: inv.lines.length };
  if (patch.removeIndexes?.length) {
    const remaining = inv.lines.filter((_: any, i: number) => !patch.removeIndexes!.includes(i));
    const newTotal = invoiceTotal(remaining, inv.discounts, inv.adjustments);
    if (newTotal < inv.paidKobo) throw stateConflict('Payments already cover those lines, so they cannot be removed.');
    inv.lines = remaining;
  }
  if (patch.addLines?.length) {
    const items = new Map<string, any>((await FeeItem.find({ _id: { $in: patch.addLines.map((l) => l.feeItemId).filter(Boolean) } }).lean()).map((i: any) => [String(i._id), i]));
    for (const l of patch.addLines) {
      const item = l.feeItemId ? items.get(l.feeItemId) : null;
      if (l.feeItemId && !item) throw notFound('Fee item');
      const label = l.label ?? item?.name;
      if (!label) throw validation('Give each line a label or a fee item.', { addLines: 'Needs a label.' });
      inv.lines.push({ feeItemId: item?._id, label, amountKobo: l.amountKobo, optional: !!item?.optional });
    }
  }
  if (patch.dueOn) inv.dueOn = patch.dueOn;
  await inv.save();
  const out = await recomputeInvoice(inv._id);
  await audit({ action: 'fees.invoice.edit', entityType: 'invoice', entityId: id, before, after: { totalKobo: out.totalKobo, lines: out.lines.length } });
  return out;
}

export async function voidInvoice(id: string, reason?: string) {
  const inv: any = await need(Invoice.findById(id), 'Invoice');
  assertTransition('invoice', inv.status, 'void', 'This invoice');
  // An invoice with payments cannot be voided.
  if (await Payment.exists({ 'allocations.invoiceId': inv._id, status: { $in: ['successful', 'pending_confirmation'] } })) throw stateConflict('This invoice has payments, so it cannot be voided.');
  inv.status = 'void';
  inv.voidedAt = new Date();
  inv.voidReason = reason;
  inv.balanceKobo = 0;
  await inv.save();
  await audit({ action: 'fees.invoice.void', entityType: 'invoice', entityId: id, reason });
  return inv;
}

// ------------------------------------------------------------------ discounts (through approvals)

export async function requestDiscount(invoiceId: string, input: { label: string; spec: { type: 'fixed'; amountKobo: number } | { type: 'percent'; percent: number }; feeItemId?: string; reason: string }) {
  const c = me();
  const inv: any = await need(Invoice.findById(invoiceId).lean(), 'Invoice');
  if (inv.status === 'void' || inv.status === 'paid') throw stateConflict('This invoice cannot take a discount.');
  let base = inv.totalKobo;
  if (input.feeItemId) {
    const line = inv.lines.find((l: any) => String(l.feeItemId) === input.feeItemId);
    if (!line) throw validation('That fee item is not on this invoice.', { feeItemId: 'Not on the invoice.' });
    base = line.amountKobo;
  }
  const amountKobo = discountAmount(base, input.spec);
  if (amountKobo <= 0) throw validation('The discount comes to nothing.', { spec: 'Too small.' });
  const approval = await Approval.create({
    type: 'discount',
    payload: { invoiceId, label: input.label, amountKobo, spec: input.spec, feeItemId: input.feeItemId, studentId: inv.studentId ? String(inv.studentId) : undefined },
    summary: `${input.label}: ₦${formatKobo(amountKobo)} off invoice ${inv.number}`,
    requestedBy: c.userId,
    reason: input.reason
  });
  await audit({ action: 'fees.discount.request', entityType: 'invoice', entityId: invoiceId, after: { amountKobo, label: input.label }, reason: input.reason });
  return approval;
}

/** On approval the invoice total drops, and an audit record is written. */
export async function applyDiscountApproval(approval: any, session?: ClientSession) {
  const p = approval.payload;
  const inv: any = await need(Invoice.findById(p.invoiceId).session(session ?? null), 'Invoice');
  if (inv.status === 'void') throw stateConflict('This invoice is void.');
  // never more than what is still due
  const room = Math.max(0, inv.totalKobo - inv.paidKobo);
  const amount = Math.min(p.amountKobo, room);
  if (amount <= 0) throw stateConflict('This invoice is already covered by payments, so a discount cannot be applied.');
  inv.discounts.push({ label: p.label, amountKobo: amount, approvalId: approval._id });
  await inv.save({ session });
  await recomputeInvoice(inv._id, session);
}

// ------------------------------------------------------------------ views

export async function invoiceView(inv: any) {
  const payments: any[] = await Payment.find({ 'allocations.invoiceId': inv._id, status: { $in: ['successful', 'reversed', 'refunded', 'pending_confirmation'] } }).sort({ createdAt: 1 }).lean();
  return {
    id: String(inv._id),
    number: inv.number,
    kind: inv.kind,
    studentId: inv.studentId ? String(inv.studentId) : undefined,
    termId: inv.termId ? String(inv.termId) : undefined,
    status: inv.status,
    lines: inv.lines,
    discounts: inv.discounts,
    adjustments: inv.adjustments,
    totalKobo: inv.totalKobo,
    paidKobo: inv.paidKobo,
    balanceKobo: inv.balanceKobo,
    dueOn: inv.dueOn,
    overdue: !!inv.dueOn && inv.dueOn < todayLagos() && inv.balanceKobo > 0 && inv.status !== 'void',
    payments: payments.map((p) => ({ id: String(p._id), reference: p.reference, channel: p.channel, status: p.status, amountKobo: p.allocations.filter((a: any) => String(a.invoiceId) === String(inv._id)).reduce((a: number, b: any) => a + b.amountKobo, 0), paidOn: p.paidOn ?? p.provider?.paidAt, createdAt: p.createdAt }))
  };
}

/** Statement of account: invoices and payments in date order with a running balance. Older invoices stay open as arrears. */
export async function statement(studentId: string) {
  const invs: any[] = await Invoice.find({ studentId, status: { $ne: 'void' } }).sort({ createdAt: 1 }).lean();
  const pays: any[] = await Payment.find({ 'allocations.studentId': studentId, status: 'successful' }).sort({ createdAt: 1 }).lean();
  const rows: Array<{ date: Date; type: 'invoice' | 'payment'; ref: string; description: string; debitKobo: number; creditKobo: number; balanceKobo: number }> = [];
  for (const i of invs) rows.push({ date: i.issuedAt ?? i.createdAt, type: 'invoice', ref: i.number, description: i.kind === 'opening_balance' ? 'Balance brought forward' : i.lines.map((l: any) => l.label).join(', '), debitKobo: i.totalKobo, creditKobo: 0, balanceKobo: 0 });
  for (const p of pays) {
    const amt = p.allocations.filter((a: any) => String(a.studentId) === studentId).reduce((a: number, b: any) => a + b.amountKobo, 0);
    if (amt > 0) rows.push({ date: p.provider?.paidAt ?? p.createdAt, type: 'payment', ref: p.reference, description: `Payment by ${p.channel}`, debitKobo: 0, creditKobo: amt, balanceKobo: 0 });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  let running = 0;
  for (const r of rows) {
    running += r.debitKobo - r.creditKobo;
    r.balanceKobo = running;
  }
  const arrears = invs.filter((i) => i.balanceKobo > 0).reduce((a, i) => a + i.balanceKobo, 0);
  return { rows, balanceKobo: running, arrearsKobo: arrears, invoices: invs.map((i) => ({ id: String(i._id), number: i.number, status: i.status, totalKobo: i.totalKobo, paidKobo: i.paidKobo, balanceKobo: i.balanceKobo, termId: i.termId ? String(i.termId) : undefined })) };
}

/** Paid, part paid or owing, without amounts (principal and admin). */
export async function feeStatus(studentId: string) {
  const invs: any[] = await Invoice.find({ studentId, status: { $in: ['issued', 'part_paid', 'paid'] } }).select('status').lean();
  if (!invs.length) return { status: 'none' as const };
  if (invs.every((i) => i.status === 'paid')) return { status: 'paid' as const };
  if (invs.some((i) => i.status === 'part_paid')) return { status: 'part_paid' as const };
  return { status: 'owing' as const };
}

export async function debtors(filter: { classArmId?: string; classLevelId?: string; termId?: string; minKobo?: number }) {
  const session = await currentSession();
  const match: any = { status: { $in: ['issued', 'part_paid'] }, balanceKobo: { $gt: filter.minKobo ?? 0 } };
  if (filter.termId) match.termId = filter.termId;
  const groups: any[] = await Invoice.aggregate([{ $match: match }, { $group: { _id: '$studentId', balanceKobo: { $sum: '$balanceKobo' }, invoices: { $sum: 1 }, oldest: { $min: '$dueOn' } } }, { $sort: { balanceKobo: -1 } }]);
  const studentIds = groups.map((g) => g._id).filter(Boolean);
  const [students, enrolments] = await Promise.all([Student.find({ _id: { $in: studentIds } }).lean(), session ? Enrolment.find({ sessionId: session._id, studentId: { $in: studentIds } }).lean() : []]);
  const sMap = new Map<string, any>(students.map((s: any) => [String(s._id), s]));
  const eMap = new Map<string, any>((enrolments as any[]).map((e) => [String(e.studentId), e]));
  const names = await classNames([...new Set((enrolments as any[]).map((e) => String(e.classArmId)))]);
  let rows = groups
    .map((g) => {
      const s = sMap.get(String(g._id));
      const e = eMap.get(String(g._id));
      return { studentId: String(g._id), admissionNumber: s?.admissionNumber, name: fullName(s), classArmId: e ? String(e.classArmId) : undefined, classLevelId: e ? String(e.classLevelId) : undefined, className: e ? names.get(String(e.classArmId))?.name : undefined, balanceKobo: g.balanceKobo, invoices: g.invoices, oldestDueOn: g.oldest };
    })
    .filter((r) => r.name);
  if (filter.classArmId) rows = rows.filter((r) => r.classArmId === filter.classArmId);
  if (filter.classLevelId) rows = rows.filter((r) => r.classLevelId === filter.classLevelId);
  return rows;
}

export async function collections(filter: { groupBy: 'day' | 'class' | 'item' | 'method' | 'term'; from?: string; to?: string; termId?: string }) {
  const match: any = { status: 'successful', channel: { $ne: 'credit' } };
  if (filter.from || filter.to) match.createdAt = { ...(filter.from ? { $gte: new Date(`${filter.from}T00:00:00+01:00`) } : {}), ...(filter.to ? { $lte: new Date(`${filter.to}T23:59:59+01:00`) } : {}) };
  const pays: any[] = await Payment.find(match).lean();
  const invIds = [...new Set(pays.flatMap((p) => p.allocations.map((a: any) => String(a.invoiceId))))];
  const invs = new Map<string, any>((await Invoice.find({ _id: { $in: invIds } }).lean()).map((i: any) => [String(i._id), i]));
  const buckets = new Map<string, number>();
  const add = (k: string, v: number) => buckets.set(k, (buckets.get(k) ?? 0) + v);
  const session = await currentSession();
  const enrolments = new Map<string, any>();
  if (filter.groupBy === 'class' && session) {
    for (const e of await Enrolment.find({ sessionId: session._id }).lean()) enrolments.set(String(e.studentId), e);
  }
  const names = filter.groupBy === 'class' ? await classNames([...new Set([...enrolments.values()].map((e) => String(e.classArmId)))]) : new Map();
  for (const p of pays) {
    for (const a of p.allocations) {
      const inv = invs.get(String(a.invoiceId));
      if (filter.termId && String(inv?.termId) !== filter.termId) continue;
      if (filter.groupBy === 'day') add(new Date(p.provider?.paidAt ?? p.createdAt).toISOString().slice(0, 10), a.amountKobo);
      else if (filter.groupBy === 'method') add(p.channel, a.amountKobo);
      else if (filter.groupBy === 'term') add(String(inv?.termId ?? 'none'), a.amountKobo);
      else if (filter.groupBy === 'class') add(names.get(String(enrolments.get(String(a.studentId))?.classArmId))?.name ?? 'No class', a.amountKobo);
      else if (filter.groupBy === 'item') {
        // Split the allocation across the invoice's lines in proportion.
        const total = inv ? inv.lines.reduce((x: number, l: any) => x + l.amountKobo, 0) : 0;
        if (!inv || !total) add('Other', a.amountKobo);
        else {
          let assigned = 0;
          inv.lines.forEach((l: any, idx: number) => {
            const share = idx === inv.lines.length - 1 ? a.amountKobo - assigned : Math.floor((a.amountKobo * l.amountKobo) / total);
            assigned += share;
            add(l.label, share);
          });
        }
      }
    }
  }
  const rows = [...buckets.entries()].map(([key, amountKobo]) => ({ key, amountKobo })).sort((a, b) => (filter.groupBy === 'day' ? a.key.localeCompare(b.key) : b.amountKobo - a.amountKobo));
  return { groupBy: filter.groupBy, rows, totalKobo: rows.reduce((a, r) => a + r.amountKobo, 0) };
}

/** Brought-forward balances as invoices. One opening balance per student. */
export async function recordOpeningBalances(items: Array<{ studentId: string; amountKobo: number; note?: string }>, importBatchId?: string) {
  const results = { created: 0, skipped: 0 };
  for (const it of items) {
    await need(Student.findById(it.studentId).select('_id').lean(), 'Student');
    if (await Invoice.exists({ studentId: it.studentId, kind: 'opening_balance', status: { $ne: 'void' } })) {
      results.skipped += 1;
      continue;
    }
    if (it.amountKobo <= 0) continue;
    await tx((s) => createInvoice({ studentId: it.studentId, kind: 'opening_balance', lines: [{ label: it.note || 'Balance brought forward', amountKobo: it.amountKobo }], importBatchId }, s));
    results.created += 1;
  }
  await audit({ action: 'fees.opening_balances', entityType: 'school', entityId: getCtx()?.schoolId, after: results });
  return results;
}

export { Receipt, sess, addDays, forbidden };
