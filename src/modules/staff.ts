import { createRoutes } from '../core/route';
import { z, objectId, name, text, dateStr, phone, email, pageQuery, idParam } from '../core/validate';
import { created, list, ok } from '../core/http';
import { getCtx } from '../core/context';
import { paging, searchRegex } from '../core/pagination';
import { Staff } from '../models';
import { GRANTABLE_EXTRAS, STAFF_ROLES } from '../core/permissions';
import { need } from '../services/common';
import * as sf from '../services/staff';
import { currentSession } from '../services/reach';
import { Membership, TeachingAssignment } from '../models';

const r = createRoutes();
export const router = r.router;

const roleEnum = z.enum(STAFF_ROLES as [string, ...string[]]);
const VIEW = { perm: 'staff.view' } as const;
const MANAGE = { perm: 'staff.manage' } as const;

r.get('/staff', { access: VIEW, query: z.object({ ...pageQuery, status: z.enum(['invited', 'active', 'deactivated']).optional(), role: roleEnum.optional() }).strict(), summary: 'List staff' }, async (req) => {
  const q = req.query as any;
  const filter: any = {};
  if (q.status) filter.status = q.status;
  if (q.role) filter.roles = q.role;
  if (q.q) filter.$or = [{ firstName: searchRegex(q.q) }, { lastName: searchRegex(q.q) }, { phone: searchRegex(q.q) }];
  const p = paging(q, ['lastName', 'firstName', 'createdAt'], 'lastName');
  const [rows, total] = await Promise.all([Staff.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), Staff.countDocuments(filter)]);
  return list(rows.map(sf.staffDisplay), { page: p.page, limit: p.limit, total });
});

r.post(
  '/staff',
  { access: MANAGE, body: z.object({ firstName: name(60), lastName: name(60), phone, email: email.optional(), roles: z.array(roleEnum).min(1), qualifications: text(300).optional(), employedOn: dateStr.optional() }).strict(), summary: 'Add a staff member and send the invite' },
  async (req) => {
    const out = await sf.addStaff(req.body);
    return created({ ...sf.staffDisplay(out.staff), inviteSent: true, existingAccount: out.invite.existingUser });
  }
);

r.get('/staff/:id', { access: VIEW, params: idParam, summary: 'One staff member with roles and assignments' }, async (req) => {
  const s = await need(Staff.findById(req.params.id).lean(), 'Staff member');
  const m: any = await Membership.findOne({ staffId: s._id, kind: 'staff' }).select('extraPermissions status').lean();
  return ok({ ...sf.staffDisplay(s), extraPermissions: m?.extraPermissions ?? [], assignments: await sf.assignmentsView({ staffId: String(s._id) }) });
});

r.patch(
  '/staff/:id',
  { access: MANAGE, params: idParam, body: z.object({ firstName: name(60).optional(), lastName: name(60).optional(), email: email.optional(), qualifications: text(300).optional(), employedOn: dateStr.optional(), photo: z.string().max(300).optional() }).strict(), summary: 'Edit details' },
  async (req) => {
    const s = await need(Staff.findById(req.params.id), 'Staff member');
    Object.assign(s, req.body);
    await s.save();
    return ok(sf.staffDisplay(s));
  }
);

r.put(
  '/staff/:id/roles',
  { access: { perm: 'staff.roles.manage' }, params: idParam, fresh: true, body: z.object({ roles: z.array(roleEnum).min(1), extraPermissions: z.array(z.enum(GRANTABLE_EXTRAS as unknown as [string, ...string[]])).default([]) }).strict(), summary: 'Set roles and extra permissions' },
  async (req) => ok(sf.staffDisplay(await sf.setStaffRoles(req.params.id as string, req.body.roles, req.body.extraPermissions)))
);

r.post('/staff/:id/resend-invite', { access: MANAGE, params: idParam, summary: 'Send the invite again' }, async (req) => {
  await sf.resendInvite(req.params.id as string);
  return ok({ sent: true });
});
r.post('/staff/:id/reset-password', { access: MANAGE, params: idParam, summary: 'Send a reset to the staff member' }, async (req) => ok(await sf.resetStaffPassword(req.params.id as string)));
r.post('/staff/:id/deactivate', { access: MANAGE, params: idParam, summary: 'Deactivate. Fails with the list of assignments to reassign if any remain' }, async (req) => ok(sf.staffDisplay(await sf.deactivateStaff(req.params.id as string))));
r.post('/staff/:id/reactivate', { access: MANAGE, params: idParam, summary: 'Reactivate' }, async (req) => ok(sf.staffDisplay(await sf.reactivateStaff(req.params.id as string))));

// ------------------------------------------------------------------ teaching assignments

r.get(
  '/teaching-assignments',
  { access: { perm: 'academics.assign.view' }, query: z.object({ sessionId: objectId.optional(), classArmId: objectId.optional(), staffId: objectId.optional() }).strict(), summary: 'Assignments for a session, by class arm or by staff' },
  async (req) => ok(await sf.assignmentsView(req.query as any))
);

r.put(
  '/teaching-assignments',
  {
    access: { perm: 'academics.assign.manage' },
    body: z.object({
      sessionId: objectId.optional(),
      items: z.array(z.object({ classArmId: objectId, subjectId: objectId.optional(), staffId: objectId.nullable(), kind: z.enum(['class_teacher', 'subject_teacher']) }).strict()).min(1).max(500),
      confirmDrafts: z.boolean().optional()
    }).strict(),
    summary: 'Set many assignments at once'
  },
  async (req) => ok(await sf.setTeachingAssignments(req.body.sessionId, req.body.items as any))
);

/** Teachers and the admin confirm assignments copied forward at rollover. */
r.post('/teaching-assignments/confirm-drafts', { access: { perm: 'academics.assign.manage' }, summary: 'Confirm assignments copied forward at rollover' }, async () => {
  const session = await currentSession();
  const res = await TeachingAssignment.updateMany({ sessionId: session?._id, draft: true }, { draft: false });
  return ok({ confirmed: res.modifiedCount });
});

r.get('/my/teaching', { access: { perm: 'academics.assign.view' }, summary: 'The caller’s class arms and subjects this session' }, async () => {
  const c = getCtx()!;
  if (!c.staffId) return ok([]);
  const rows = await sf.assignmentsView({ staffId: c.staffId });
  return ok(rows);
});
