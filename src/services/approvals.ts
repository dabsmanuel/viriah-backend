import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { tx } from '../core/db';
import { forbidden, stateConflict } from '../core/errors';
import { assertTransition } from '../core/states';
import { can, me } from '../core/http';
import { Approval, ChangeRequest, ClassResult, PromotionList, User } from '../models';
import { applyDiscountApproval } from './fees';
import { applyRefund, applyReversal } from './payments';
import { fullName, need } from './common';
import { classNames } from './students';
import { notify } from './notify';

/**
 * One approvals queue for the principal and owner: results to approve, promotion lists, discounts, refunds, profile change
 * requests (OWN-02). Discounts, reversals and refunds are Approval documents decided here. Results and promotion lists are
 * approved on their own screens, and appear in the queue so nothing waits unseen.
 */

const TYPE_PERMISSION = {
  discount: 'fees.discount.approve',
  reversal: 'fees.refund.approve',
  refund: 'fees.refund.approve'
} as const;

export async function pendingApprovals() {
  const out: Record<string, any[]> = { discounts: [], refunds: [], results: [], promotion: [], contactChanges: [] };

  const money: any[] = await Approval.find({ status: 'pending' }).sort({ createdAt: 1 }).lean();
  const users = new Map<string, any>((await User.find({ _id: { $in: money.map((m) => m.requestedBy).filter(Boolean) } }).select('firstName lastName').lean()).map((u: any) => [String(u._id), u]));
  for (const a of money) {
    const row = { id: String(a._id), type: a.type, summary: a.summary, payload: a.payload, reason: a.reason, requestedBy: fullName(users.get(String(a.requestedBy))), createdAt: a.createdAt, canDecide: can(TYPE_PERMISSION[a.type as keyof typeof TYPE_PERMISSION] ?? 'approvals.view') };
    if (a.type === 'discount' && can('fees.discount.approve')) out.discounts.push(row);
    if ((a.type === 'refund' || a.type === 'reversal') && can('fees.refund.approve')) out.refunds.push(row);
  }

  if (can('results.approve')) {
    const rs: any[] = await ClassResult.find({ status: 'awaiting_approval' }).sort({ submittedAt: 1 }).lean();
    const names = await classNames(rs.map((r) => String(r.classArmId)));
    out.results = rs.map((r) => ({ id: String(r._id), classArmId: String(r.classArmId), termId: String(r.termId), class: names.get(String(r.classArmId))?.name, submittedAt: r.submittedAt }));
  }
  if (can('promotion.approve')) {
    const ps: any[] = await PromotionList.find({ status: 'reviewed' }).sort({ reviewedAt: 1 }).lean();
    const names = await classNames(ps.map((r) => String(r.classArmId)));
    out.promotion = ps.map((p) => ({ id: String(p._id), classArmId: String(p.classArmId), sessionId: String(p.sessionId), class: names.get(String(p.classArmId))?.name, reviewedAt: p.reviewedAt }));
  }
  if (can('contact.change.decide')) {
    const cs: any[] = await ChangeRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).lean();
    const cu = new Map<string, any>((await User.find({ _id: { $in: cs.map((c) => c.userId) } }).select('firstName lastName').lean()).map((u: any) => [String(u._id), u]));
    out.contactChanges = cs.map((c) => ({ id: String(c._id), user: fullName(cu.get(String(c.userId))), changes: c.changes, target: c.target, createdAt: c.createdAt }));
  }
  const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
  return { counts: { ...counts, total: Object.values(counts).reduce((a: number, b) => a + (b as number), 0) }, ...out };
}

async function load(id: string) {
  const a: any = await need(Approval.findById(id), 'Approval request');
  const key = TYPE_PERMISSION[a.type as keyof typeof TYPE_PERMISSION];
  if (!key) throw stateConflict('This kind of request is decided on its own screen.');
  if (!can(key)) throw forbidden();
  return a;
}

export async function approve(id: string, opts: { manualRefund?: boolean } = {}) {
  const c = me();
  const a = await load(id);
  assertTransition('approval', a.status, 'approved', 'This request');
  // The same person asking and approving is allowed in a one-person school, but it is flagged and audited.
  const self = String(a.requestedBy) === c.userId;
  await tx(async (session) => {
    if (a.type === 'discount') await applyDiscountApproval(a, session);
    else if (a.type === 'reversal') await applyReversal(a, session);
    // refunds call the provider outside the transaction, below
    a.status = 'approved';
    a.decidedBy = c.userId;
    a.decidedAt = new Date();
    if (a.type !== 'refund') await a.save({ session });
  });
  if (a.type === 'refund') {
    await applyRefund(a, !!opts.manualRefund);
    a.status = 'approved';
    a.decidedBy = c.userId;
    a.decidedAt = new Date();
    await a.save();
  }
  await audit({ action: `approvals.${a.type}.approve`, entityType: 'approval', entityId: id, after: { ...a.payload, selfApproved: self } });
  if (a.requestedBy) await notify({ event: 'approval_event', to: [{ userId: String(a.requestedBy), kind: 'staff' }], vars: { title: 'Request approved', body: a.summary ?? 'Your request was approved.' } });
  return a;
}

export async function decline(id: string, reason: string) {
  const c = me();
  const a = await load(id);
  assertTransition('approval', a.status, 'declined', 'This request');
  a.status = 'declined';
  a.decidedBy = c.userId;
  a.decidedAt = new Date();
  a.decisionNote = reason;
  await a.save();
  await audit({ action: `approvals.${a.type}.decline`, entityType: 'approval', entityId: id, reason });
  if (a.requestedBy) await notify({ event: 'approval_event', to: [{ userId: String(a.requestedBy), kind: 'staff' }], vars: { title: 'Request declined', body: `${a.summary ?? 'Your request'} was declined. ${reason}` } });
  return a;
}

export { getCtx };
