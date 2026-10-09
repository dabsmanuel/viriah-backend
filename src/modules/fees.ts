import { createRoutes } from '../core/route';
import { z, objectId, name, text, dateStr, kobo, pageQuery, idParam } from '../core/validate';
import { accepted, created, list, ok } from '../core/http';
import { can, me } from '../core/http';
import { exportRows, paging, searchRegex } from '../core/pagination';
import { notFound } from '../core/errors';
import { FeeItem, Invoice, Student, Term } from '../models';
import { need, fullName } from '../services/common';
import * as fees from '../services/fees';
import * as approvals from '../services/approvals';
import { assertCanSeeStudent, myChildIds } from '../services/reach';

const r = createRoutes();
export const router = r.router;

// ------------------------------------------------------------------ fee items and structures

r.get('/fee-items', { access: { perm: 'fees.structure.view' }, summary: 'List fee items' }, async () => ok(await FeeItem.find({}).sort({ name: 1 }).lean()));
r.post('/fee-items', { access: { perm: 'fees.structure.manage' }, body: z.object({ name: name(80), optional: z.boolean().default(false) }).strict(), summary: 'Add a fee item' }, async (req) => created(await fees.createFeeItem(req.body)));
r.patch('/fee-items/:id', { access: { perm: 'fees.structure.manage' }, params: idParam, body: z.object({ name: name(80).optional(), optional: z.boolean().optional(), active: z.boolean().optional() }).strict(), summary: 'Edit or deactivate a fee item' }, async (req) => ok(await fees.updateFeeItem(req.params.id as string, req.body)));

r.get('/fee-structures', { access: { perm: 'fees.structure.view' }, query: z.object({ termId: objectId.optional(), classLevelId: objectId.optional() }).strict(), summary: 'Fee structure for a term, all levels or one' }, async (req) => {
  const q = req.query as any;
  return ok(await fees.feeStructures(q.termId, q.classLevelId));
});

r.put(
  '/fee-structures',
  { access: { perm: 'fees.structure.manage' }, body: z.object({ termId: objectId, classLevelId: objectId, lines: z.array(z.object({ feeItemId: objectId, amountKobo: kobo }).strict()).max(40) }).strict(), summary: 'Set the amounts for a term and class level' },
  async (req) => {
    const doc = await fees.setFeeStructure(req.body.termId, req.body.classLevelId, req.body.lines);
    return ok({ id: String(doc._id), lines: doc.lines });
  }
);

r.post('/fee-structures/copy', { access: { perm: 'fees.structure.manage' }, body: z.object({ fromTermId: objectId, toTermId: objectId }).strict(), summary: 'Copy a previous term’s structure into a term' }, async (req) => ok(await fees.copyFeeStructure(req.body.fromTermId, req.body.toTermId)));

// ------------------------------------------------------------------ invoices

r.post(
  '/invoices/generate',
  { access: { perm: 'fees.invoice.manage' }, idem: true, requireActive: false, body: z.object({ termId: objectId, classLevelIds: z.array(objectId).max(30).optional(), regenerateUnpaid: z.boolean().default(false) }).strict(), summary: 'Create invoices for a term for all active students, or chosen levels' },
  async (req) => accepted(await fees.startInvoiceGeneration(req.body.termId, req.body.classLevelIds, req.body.regenerateUnpaid))
);

r.get(
  '/invoices',
  { access: { perm: 'fees.invoice.view' }, query: z.object({ ...pageQuery, studentId: objectId.optional(), termId: objectId.optional(), status: z.enum(['draft', 'issued', 'part_paid', 'paid', 'void']).optional(), kind: z.enum(['term', 'admission', 'application', 'opening_balance', 'single']).optional(), overdue: z.enum(['true']).optional() }).strict(), summary: 'List invoices with filters' },
  async (req) => {
    const q = req.query as any;
    const filter: any = {};
    for (const k of ['studentId', 'termId', 'status', 'kind']) if (q[k]) filter[k] = q[k];
    if (q.overdue) {
      filter.balanceKobo = { $gt: 0 };
      filter.dueOn = { $lt: new Date().toISOString().slice(0, 10) };
      filter.status = { $in: ['issued', 'part_paid'] };
    }
    if (q.q) {
      const students: any[] = await Student.find({ $or: [{ firstName: searchRegex(q.q) }, { lastName: searchRegex(q.q) }, { admissionNumber: searchRegex(q.q) }] }).select('_id').limit(200).lean();
      filter.$or = [{ number: searchRegex(q.q) }, { studentId: { $in: students.map((s) => s._id) } }];
    }
    const p = paging(q, ['createdAt', 'number', 'totalKobo', 'balanceKobo', 'dueOn'], '-createdAt');
    const [rows, total] = await Promise.all([Invoice.find(filter).sort(p.sort).skip(q.format ? 0 : p.skip).limit(q.format ? 5000 : p.limit).lean(), Invoice.countDocuments(filter)]);
    const students = new Map<string, any>((await Student.find({ _id: { $in: rows.map((x: any) => x.studentId).filter(Boolean) } }).select('firstName lastName admissionNumber').lean()).map((s: any) => [String(s._id), s]));
    const data = rows.map((x: any) => ({ id: String(x._id), number: x.number, kind: x.kind, status: x.status, studentId: x.studentId ? String(x.studentId) : undefined, student: fullName(students.get(String(x.studentId))) || x.payerName, admissionNumber: students.get(String(x.studentId))?.admissionNumber, termId: x.termId ? String(x.termId) : undefined, totalKobo: x.totalKobo, paidKobo: x.paidKobo, balanceKobo: x.balanceKobo, dueOn: x.dueOn, createdAt: x.createdAt }));
    if (q.format) {
      return ok(
        await exportRows(
          'invoices',
          [
            { header: 'Invoice', value: (x: any) => x.number },
            { header: 'Admission number', value: (x: any) => x.admissionNumber },
            { header: 'Student', value: (x: any) => x.student },
            { header: 'Status', value: (x: any) => x.status },
            { header: 'Total (kobo)', value: (x: any) => x.totalKobo },
            { header: 'Paid (kobo)', value: (x: any) => x.paidKobo },
            { header: 'Balance (kobo)', value: (x: any) => x.balanceKobo }
          ],
          data,
          q.format
        )
      );
    }
    return list(data, { page: p.page, limit: p.limit, total });
  }
);

r.post(
  '/invoices',
  {
    access: { perm: 'fees.invoice.manage' },
    idem: true,
    body: z.object({ studentId: objectId, termId: objectId.optional(), lines: z.array(z.object({ feeItemId: objectId.optional(), label: text(120).optional(), amountKobo: kobo.refine((v) => v > 0, 'Enter an amount above zero.') }).strict()).min(1).max(30), dueOn: dateStr.optional() }).strict(),
    summary: 'Raise a single invoice for a student'
  },
  async (req) => {
    const inv = await fees.raiseSingleInvoice(req.body);
    return created(await fees.invoiceView(inv));
  }
);

r.get('/invoices/:id', { access: { perm: ['fees.invoice.view', 'fees.own.view'] }, params: idParam, summary: 'One invoice with its payments' }, async (req) => {
  const inv = await need(Invoice.findById(req.params.id).lean(), 'Invoice');
  if (!can('fees.invoice.view')) {
    if (!inv.studentId || !(await myChildIds()).includes(String(inv.studentId))) throw notFound('Invoice');
  }
  return ok(await fees.invoiceView(inv));
});

r.patch(
  '/invoices/:id',
  {
    access: { perm: 'fees.invoice.manage' },
    params: idParam,
    body: z.object({ addLines: z.array(z.object({ feeItemId: objectId.optional(), label: text(120).optional(), amountKobo: kobo.refine((v) => v > 0) }).strict()).max(20).optional(), removeIndexes: z.array(z.number().int().min(0)).max(30).optional(), dueOn: dateStr.optional() }).strict(),
    summary: 'Add or remove lines. Lines covered by payments cannot be removed'
  },
  async (req) => ok(await fees.invoiceView(await fees.editInvoice(req.params.id as string, req.body)))
);

r.post('/invoices/:id/void', { access: { perm: 'fees.invoice.manage' }, params: idParam, body: z.object({ reason: text(300).optional() }).strict().optional(), summary: 'Void an invoice that has no payments' }, async (req) => ok(await fees.invoiceView(await fees.voidInvoice(req.params.id as string, (req.body as any)?.reason))));

r.post(
  '/invoices/:id/discounts',
  {
    access: { perm: 'fees.discount.request' },
    params: idParam,
    body: z.object({
      label: name(80),
      feeItemId: objectId.optional(),
      reason: text(300).min(3, 'Give a reason.'),
      type: z.enum(['fixed', 'percent']),
      amountKobo: kobo.optional(),
      percent: z.number().min(0.01).max(100).optional()
    }).strict().refine((b) => (b.type === 'fixed' ? b.amountKobo !== undefined : b.percent !== undefined), 'Give the amount or the percentage.'),
    summary: 'Request a discount. Creates an approval request'
  },
  async (req) => {
    const b = req.body;
    const approval = await fees.requestDiscount(req.params.id as string, { label: b.label, feeItemId: b.feeItemId, reason: b.reason, spec: b.type === 'fixed' ? { type: 'fixed', amountKobo: b.amountKobo! } : { type: 'percent', percent: b.percent! } });
    return created({ approvalId: String(approval._id), status: 'pending', amountKobo: approval.payload.amountKobo });
  }
);

r.post('/fees/opening-balances', { access: { perm: 'fees.opening.manage' }, idem: true, body: z.object({ items: z.array(z.object({ studentId: objectId, amountKobo: kobo, note: text(120).optional() }).strict()).min(1).max(1000) }).strict(), summary: 'Record brought-forward balances as invoices' }, async (req) => ok(await fees.recordOpeningBalances(req.body.items)));

// ------------------------------------------------------------------ statements and reports

r.get('/students/:id/statement', { access: { perm: ['fees.invoice.view', 'fees.own.view'] }, params: idParam, summary: 'Statement of account' }, async (req) => {
  if (!can('fees.invoice.view')) {
    if (!(await myChildIds()).includes(req.params.id as string)) throw notFound('Student');
  } else await assertCanSeeStudent(req.params.id as string);
  return ok(await fees.statement(req.params.id as string));
});

r.get('/students/:id/fee-status', { access: { perm: 'fees.status.view' }, params: idParam, summary: 'Paid, part paid or owing, without amounts' }, async (req) => {
  await assertCanSeeStudent(req.params.id as string);
  return ok(await fees.feeStatus(req.params.id as string));
});

r.get('/fees/debtors', { access: { perm: 'fees.reports.view' }, query: z.object({ ...pageQuery, classArmId: objectId.optional(), classLevelId: objectId.optional(), termId: objectId.optional(), minKobo: z.coerce.number().int().nonnegative().optional() }).strict(), summary: 'Students owing, with amounts, by class' }, async (req) => {
  const q = req.query as any;
  const rows = await fees.debtors(q);
  if (q.format) {
    return ok(
      await exportRows(
        'debtors',
        [
          { header: 'Admission number', value: (x: any) => x.admissionNumber },
          { header: 'Student', value: (x: any) => x.name },
          { header: 'Class', value: (x: any) => x.className },
          { header: 'Balance (kobo)', value: (x: any) => x.balanceKobo }
        ],
        rows,
        q.format
      )
    );
  }
  const start = (q.page - 1) * q.limit;
  return list(rows.slice(start, start + q.limit), { page: q.page, limit: q.limit, total: rows.length }, { totalKobo: rows.reduce((a, x) => a + x.balanceKobo, 0) });
});

r.get('/fees/collections', { access: { perm: 'fees.reports.view' }, query: z.object({ groupBy: z.enum(['day', 'class', 'item', 'method', 'term']).default('day'), from: dateStr.optional(), to: dateStr.optional(), termId: objectId.optional(), format: z.enum(['xlsx', 'csv']).optional() }).strict(), summary: 'Collections grouped by day, class, fee item or method' }, async (req) => {
  const q = req.query as any;
  const out = await fees.collections(q);
  if (q.format) return ok(await exportRows('collections', [{ header: q.groupBy, value: (x: any) => x.key }, { header: 'Collected (kobo)', value: (x: any) => x.amountKobo }], out.rows, q.format));
  return ok(out);
});

// ------------------------------------------------------------------ approvals

r.get('/approvals', { access: { perm: 'approvals.view' }, summary: 'Requests waiting, by type' }, async () => ok(await approvals.pendingApprovals()));
r.post('/approvals/:id/approve', { access: { perm: 'approvals.view' }, params: idParam, fresh: true, body: z.object({ manualRefund: z.boolean().optional() }).strict().optional(), summary: 'Approve. Applies the discount, reversal, refund or other change' }, async (req) => {
  const a = await approvals.approve(req.params.id as string, { manualRefund: (req.body as any)?.manualRefund });
  return ok({ id: String(a._id), status: a.status });
});
r.post('/approvals/:id/decline', { access: { perm: 'approvals.view' }, params: idParam, body: z.object({ reason: text(300).min(3, 'Give a reason.') }).strict(), summary: 'Decline with a reason' }, async (req) => {
  const a = await approvals.decline(req.params.id as string, req.body.reason);
  return ok({ id: String(a._id), status: a.status });
});

export { Term, me };
