import { createRoutes } from '../core/route';
import { z, objectId, name, text, dateStr, phone, email, pageQuery, idParam, optId } from '../core/validate';
import { created, list, noContent, ok } from '../core/http';
import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { notFound, stateConflict, validation } from '../core/errors';
import { exportRows, paging, searchRegex } from '../core/pagination';
import { AcademicSession, Enrolment, Guardian, StudentDocument, Student, StudentGuardian, ChangeRequest, Membership, User } from '../models';
import { need, fullName, loadSchool, adminRecipients, platformSettings } from '../services/common';
import * as st from '../services/students';
import { currentSession, assertCanSeeStudent, myChildIds } from '../services/reach';
import { confirmFile } from '../services/files';
import { sendFamilyLogins, ensureGuardianAccount, resetToTemporaryPassword, guardiansOfStudent } from '../services/accounts';
import { notify } from '../services/notify';
import { schoolLink } from '../lib/links';
import { ClassLevel } from '../models';
import { me } from '../core/http';
import { photoUrl } from '../services/common';

const r = createRoutes();
export const router = r.router;

const childSchema = z.object({
  firstName: name(60),
  middleName: z.string().trim().max(60).optional(),
  lastName: name(60),
  dob: dateStr,
  gender: z.enum(['male', 'female']),
  address: text(300).optional(),
  stateOfOrigin: text(60).optional(),
  religion: text(40).optional(),
  photo: z.string().max(300).optional(),
  medical: z.object({ notes: text(1000).optional(), allergies: text(500).optional(), emergencyName: text(100).optional(), emergencyPhone: phone.optional() }).strict().optional()
}).strict();

const guardianSchema = z.object({
  firstName: name(60),
  lastName: name(60),
  phone,
  email: email.optional(),
  address: text(300).optional(),
  occupation: text(80).optional(),
  relationship: text(30).optional(),
  isPrimary: z.boolean().optional(),
  isFeePayer: z.boolean().optional()
}).strict();

const LIST = { perm: 'students.list.view' } as const;

// ------------------------------------------------------------------ list, create, duplicates

r.get(
  '/students',
  {
    access: LIST,
    query: z.object({ ...pageQuery, classArmId: objectId.optional(), classLevelId: objectId.optional(), status: z.enum(['active', 'suspended', 'withdrawn', 'transferred', 'graduated']).optional(), sessionId: objectId.optional() }).strict(),
    summary: 'List students with filters for class, status and search'
  },
  async (req) => {
    const q = req.query as any;
    const reach = await st.visibleStudentFilter();
    if (reach === null) return list([], { page: 1, limit: q.limit, total: 0 });
    const session = q.sessionId ? { _id: q.sessionId } : await currentSession();
    const filter: Record<string, any> = { ...reach };
    if (q.status) filter.status = q.status;
    if (q.q) filter.$or = [{ firstName: searchRegex(q.q) }, { lastName: searchRegex(q.q) }, { admissionNumber: searchRegex(q.q) }];
    if ((q.classArmId || q.classLevelId) && session) {
      const e: any[] = await Enrolment.find({ sessionId: session._id, ...(q.classArmId ? { classArmId: q.classArmId } : {}), ...(q.classLevelId ? { classLevelId: q.classLevelId } : {}) }).select('studentId').lean();
      const ids = e.map((x) => x.studentId);
      filter._id = filter._id?.$in ? { $in: filter._id.$in.filter((x: any) => ids.some((i: any) => String(i) === String(x))) } : { $in: ids };
    }
    const p = paging(q, ['lastName', 'firstName', 'admissionNumber', 'createdAt'], 'lastName');
    const [rows, total] = await Promise.all([Student.find(filter).sort(p.sort).skip(q.format ? 0 : p.skip).limit(q.format ? 5000 : p.limit).lean(), Student.countDocuments(filter)]);
    const data = await st.studentRows(rows, session ? String(session._id) : undefined);
    if (q.format) {
      return ok(
        await exportRows(
          'students',
          [
            { header: 'Admission number', value: (s: any) => s.admissionNumber },
            { header: 'First name', value: (s: any) => s.firstName },
            { header: 'Last name', value: (s: any) => s.lastName },
            { header: 'Gender', value: (s: any) => s.gender },
            { header: 'Class', value: (s: any) => s.className },
            { header: 'Status', value: (s: any) => s.status }
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
  '/students',
  {
    access: { perm: 'admissions.enrol' },
    idem: true,
    body: z.object({
      child: childSchema,
      guardians: z.array(guardianSchema).min(1).max(4),
      classArmId: objectId,
      consentOnFile: z.boolean().default(false),
      consentFile: z.string().max(300).optional(),
      confirmDuplicate: z.boolean().default(false),
      issueLogins: z.boolean().optional()
    }).strict(),
    summary: 'Direct admission: create the student, guardians, enrolment and accounts'
  },
  async (req) => {
    const b = req.body;
    // Duplicate check, then the same enrolment step as an application (F6). Staff decide on a warning.
    const dup = await st.findDuplicates(b.child, b.guardians[0].phone);
    if (dup.duplicate && !b.confirmDuplicate) {
      throw stateConflict('This looks like a child who is already in the school or has applied. Check, then confirm to continue.', { duplicates: dup, needsConfirmation: true });
    }
    if (!b.consentOnFile) throw validation('Tick that the guardian’s consent is on file, or use the public application form.', { consentOnFile: 'Required.' });
    const consentText = (await platformSettings()).legalTexts?.consent;
    const out = await st.enrolStudent(
      { child: b.child, guardians: b.guardians, classArmId: b.classArmId, consent: { onFile: true, source: 'paper', at: new Date(), text: consentText }, issueLogins: b.issueLogins },
      {}
    );
    if (b.consentFile) {
      await confirmFile(b.consentFile, 'student_document');
      await StudentDocument.create({ ownerType: 'student', ownerId: out.student._id, title: 'Signed consent form', file: b.consentFile, visibleToGuardian: false, uploadedBy: getCtx()!.userId });
    }
    return created({ id: String(out.student._id), admissionNumber: out.student.admissionNumber, guardianIds: out.guardians.map((g: any) => String(g._id)) });
  }
);

r.post('/students/duplicates/check', { access: { perm: 'admissions.enrol' }, body: z.object({ firstName: name(60), lastName: name(60), dob: dateStr, guardianPhone: phone.optional() }).strict(), summary: 'Check a child’s details against existing students and applications' }, async (req) =>
  ok(await st.findDuplicates(req.body, req.body.guardianPhone))
);

// ------------------------------------------------------------------ one student

r.get('/students/:id', { access: { perm: 'students.profile.view' }, params: idParam, summary: 'One student. Fields returned depend on the caller’s permissions' }, async (req) => ok(await st.studentView(req.params.id as string)));

r.patch('/students/:id', { access: { perm: 'students.profile.manage' }, params: idParam, body: childSchema.partial().strict(), summary: 'Edit profile' }, async (req) => {
  if (req.body.photo) await confirmFile(req.body.photo, 'student_photo');
  await st.updateStudentProfile(req.params.id as string, req.body);
  return ok(await st.studentView(req.params.id as string));
});

r.post(
  '/students/:id/status',
  {
    access: { perm: 'students.status.manage' },
    params: idParam,
    body: z.object({ status: z.enum(['active', 'suspended', 'withdrawn', 'transferred', 'graduated']), date: dateStr, reason: text(300).min(3, 'Give a reason.'), classArmId: objectId.optional() }).strict(),
    summary: 'Change status with date and reason'
  },
  async (req) => {
    const s = await st.changeStudentStatus(req.params.id as string, req.body);
    return ok({ id: String(s._id), status: s.status });
  }
);

r.post('/students/:id/move', { access: { perm: 'students.move' }, params: idParam, body: z.object({ classArmId: objectId, date: dateStr.optional() }).strict(), summary: 'Move to another class arm in the current session' }, async (req) => {
  const e = await st.moveStudent(req.params.id as string, req.body.classArmId, req.body.date);
  return ok({ classArmId: String(e.classArmId), classLevelId: String(e.classLevelId) });
});

r.get('/students/:id/enrolments', { access: { perm: 'students.profile.view' }, params: idParam, summary: 'Enrolment history' }, async (req) => {
  await assertCanSeeStudent(req.params.id as string);
  const rows: any[] = await Enrolment.find({ studentId: req.params.id }).sort({ createdAt: -1 }).lean();
  const names = await st.classNames([...new Set(rows.map((x) => String(x.classArmId)))]);
  const sessions = new Map<string, any>((await AcademicSession.find({ _id: { $in: rows.map((x) => x.sessionId) } }).lean()).map((s: any) => [String(s._id), s]));
  return ok(rows.map((x) => ({ id: String(x._id), sessionId: String(x.sessionId), session: sessions.get(String(x.sessionId))?.name, classArmId: String(x.classArmId), class: names.get(String(x.classArmId))?.name, from: x.from, to: x.to, outcome: x.outcome, imported: !!x.imported })));
});

// ------------------------------------------------------------------ documents

r.get('/students/:id/documents', { access: { perm: 'students.documents.view' }, params: idParam, summary: 'List documents' }, async (req) => {
  const docs = await st.listDocuments(req.params.id as string);
  return ok(docs.map((d: any) => ({ id: String(d._id), title: d.title, file: d.file, url: photoUrl(d.file), mime: d.mime, visibleToGuardian: d.visibleToGuardian, createdAt: d.createdAt })));
});
r.post('/students/:id/documents', { access: { perm: 'students.documents.manage' }, params: idParam, body: z.object({ title: name(120), file: z.string().min(10).max(300), visibleToGuardian: z.boolean().default(false) }).strict(), summary: 'Attach a document' }, async (req) => {
  await need(Student.findById(req.params.id).select('_id').lean(), 'Student');
  await confirmFile(req.body.file, 'student_document');
  const d = await StudentDocument.create({ ownerType: 'student', ownerId: req.params.id, ...req.body, uploadedBy: getCtx()!.userId });
  await audit({ action: 'students.document.add', entityType: 'student', entityId: req.params.id, after: { title: req.body.title } });
  return created({ id: String(d._id) });
});
r.delete('/students/:id/documents/:docId', { access: { perm: 'students.documents.manage' }, params: z.object({ id: objectId, docId: objectId }).strict(), summary: 'Remove a document' }, async (req) => {
  const res = await StudentDocument.deleteOne({ _id: req.params.docId, ownerId: req.params.id });
  if (!res.deletedCount) throw notFound('Document');
  await audit({ action: 'students.document.remove', entityType: 'student', entityId: req.params.id as string, after: { docId: req.params.docId } });
  return noContent();
});

// ------------------------------------------------------------------ guardians

r.get('/students/:id/guardians', { access: { perm: 'students.guardians.view' }, params: idParam, summary: 'Guardians linked to a student' }, async (req) => {
  await assertCanSeeStudent(req.params.id as string);
  return ok(await st.guardianLinks(req.params.id as string));
});

r.post('/students/:id/guardians', { access: { perm: 'students.guardians.manage' }, params: idParam, body: guardianSchema.extend({ guardianId: objectId.optional() }).partial({ firstName: true, lastName: true, phone: true }).strict(), summary: 'Link an existing guardian by phone or create a new one' }, async (req) => {
  const b = req.body as any;
  if (!b.guardianId && !(b.firstName && b.lastName && b.phone)) throw validation('Give the guardian’s name and phone, or choose an existing guardian.', { phone: 'Required.' });
  const g = await st.linkGuardian(req.params.id as string, b);
  return created({ guardianId: String(g._id) });
});

r.patch(
  '/students/:id/guardians/:gid',
  {
    access: { perm: 'students.guardians.manage' },
    params: z.object({ id: objectId, gid: objectId }).strict(),
    body: z.object({ relationship: text(30).optional(), isPrimary: z.boolean().optional(), isFeePayer: z.boolean().optional(), access: z.enum(['full', 'view', 'none']).optional(), reason: text(300).optional() }).strict(),
    summary: 'Edit relationship, main contact, fee payer, access'
  },
  async (req) => {
    await st.updateGuardianLink(req.params.id as string, req.params.gid as string, req.body);
    return ok(await st.guardianLinks(req.params.id as string));
  }
);

r.delete('/students/:id/guardians/:gid', { access: { perm: 'students.guardians.manage' }, params: z.object({ id: objectId, gid: objectId }).strict(), summary: 'Unlink a guardian. The last guardian cannot be removed' }, async (req) => {
  await st.unlinkGuardian(req.params.id as string, req.params.gid as string);
  return noContent();
});

r.get('/guardians', { access: { perm: 'students.guardians.manage' }, query: z.object({ ...pageQuery }).strict(), summary: 'List guardians' }, async (req) => {
  const q = req.query as any;
  const filter: any = q.q ? { $or: [{ firstName: searchRegex(q.q) }, { lastName: searchRegex(q.q) }, { phone: searchRegex(q.q) }] } : {};
  const p = paging(q, ['lastName', 'firstName', 'createdAt'], 'lastName');
  const [rows, total] = await Promise.all([Guardian.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), Guardian.countDocuments(filter)]);
  return list(rows.map((g: any) => ({ id: String(g._id), firstName: g.firstName, lastName: g.lastName, phone: g.phone, email: g.email, hasLogin: !!g.userId, invitedAt: g.lastInvitedAt })), { page: p.page, limit: p.limit, total });
});

r.get('/guardians/:id', { access: { perm: 'students.guardians.manage' }, params: idParam, summary: 'One guardian with linked students' }, async (req) => {
  const g: any = await need(Guardian.findById(req.params.id).lean(), 'Guardian');
  const links: any[] = await StudentGuardian.find({ guardianId: g._id }).lean();
  const students: any[] = await Student.find({ _id: { $in: links.map((l) => l.studentId) } }).lean();
  const rows = await st.studentRows(students);
  return ok({ id: String(g._id), firstName: g.firstName, lastName: g.lastName, phone: g.phone, email: g.email, address: g.address, occupation: g.occupation, hasLogin: !!g.userId, students: rows.map((s) => ({ ...s, relationship: links.find((l) => String(l.studentId) === s.id)?.relationship })) });
});

r.patch('/guardians/:id', { access: { perm: 'students.guardians.manage' }, params: idParam, body: z.object({ firstName: name(60).optional(), lastName: name(60).optional(), phone: phone.optional(), email: email.optional(), address: text(300).optional(), occupation: text(80).optional() }).strict(), summary: 'Edit guardian details' }, async (req) => {
  const g = await st.updateGuardian(req.params.id as string, req.body);
  return ok({ id: String(g._id), phone: g.phone, email: g.email });
});

// ------------------------------------------------------------------ issue logins

r.post('/students/:id/issue-login', { access: { perm: 'students.guardians.manage' }, requireActive: true, params: idParam, summary: 'Create or resend the student’s login' }, async (req) => {
  const s: any = await need(Student.findById(req.params.id), 'Student');
  const session = await currentSession();
  const enrol: any = session ? await Enrolment.findOne({ studentId: s._id, sessionId: session._id }).lean() : null;
  const lvl: any = enrol ? await ClassLevel.findById(enrol.classLevelId).lean() : null;
  const school: any = await loadSchool();
  const gs = await guardiansOfStudent(s._id);
  const out = await sendFamilyLogins({ school, student: s, guardians: gs as any[], studentLogin: !!lvl?.studentLogin, resend: true });
  await audit({ action: 'accounts.student_login.issue', entityType: 'student', entityId: s._id });
  return ok(out);
});

r.post('/guardians/:id/issue-login', { access: { perm: 'students.guardians.manage' }, requireActive: true, params: idParam, summary: 'Create or resend the guardian’s login' }, async (req) => {
  const g: any = await need(Guardian.findById(req.params.id), 'Guardian');
  const school: any = await loadSchool();
  const issued = await ensureGuardianAccount(g, String(school._id));
  let temp = issued.temporaryPassword;
  if (!temp) temp = await resetToTemporaryPassword(issued.userId);
  await notify({ event: 'temp_password', to: [{ userId: issued.userId, phone: g.phone, email: g.email, kind: 'parent' }], vars: { password: temp, link: schoolLink(school.slug, '/portal/login') } });
  await audit({ action: 'accounts.guardian_login.issue', entityType: 'guardian', entityId: g._id });
  return ok({ sent: true });
});

// ------------------------------------------------------------------ contact change requests (POR-06)

r.get('/change-requests', { access: { perm: 'contact.change.decide' }, summary: 'Contact change requests waiting' }, async () => {
  const rows: any[] = await ChangeRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).lean();
  const users = new Map<string, any>((await User.find({ _id: { $in: rows.map((x) => x.userId) } }).select('firstName lastName').lean()).map((u: any) => [String(u._id), u]));
  return ok(rows.map((x) => ({ id: String(x._id), user: fullName(users.get(String(x.userId))), target: x.target, changes: x.changes, createdAt: x.createdAt })));
});

r.post(
  '/change-requests',
  { access: { perm: 'contact.change.request' }, body: z.object({ changes: z.object({ phone: phone.optional(), email: email.optional(), address: text(300).optional() }).strict().refine((c) => Object.keys(c).length > 0, 'Choose what to change.') }).strict(), summary: 'Ask for a change to own contact details' },
  async (req) => {
    const c = me();
    const target = c.guardianId ? 'guardian' : 'student';
    if (target === 'student' && (req.body.changes.phone || req.body.changes.email)) throw validation('Students can ask to change their address only. Ask a parent to change phone or email.');
    const doc = await ChangeRequest.create({ userId: c.userId, target, targetId: c.guardianId ?? c.studentId, changes: req.body.changes });
    await notify({ event: 'contact_change', to: await adminRecipients(c.schoolId!), vars: { name: c.displayName } });
    return created({ id: String(doc._id), status: 'pending' });
  }
);

r.post('/change-requests/:id/decide', { access: { perm: 'contact.change.decide' }, params: idParam, body: z.object({ decision: z.enum(['approve', 'decline']), reason: text(300).optional() }).strict(), summary: 'Approve or decline' }, async (req) => {
  const out = await decideChangeRequest(req.params.id as string, req.body.decision, req.body.reason);
  return ok(out);
});

export async function decideChangeRequest(id: string, decision: 'approve' | 'decline', reason?: string) {
  const c = me();
  const cr: any = await need(ChangeRequest.findById(id), 'Request');
  if (cr.status !== 'pending') throw stateConflict('This request was already decided.');
  if (decision === 'approve') {
    if (cr.target === 'guardian') await st.updateGuardian(String(cr.targetId), cr.changes);
    else await st.updateStudentProfile(String(cr.targetId), { address: cr.changes?.address });
    if (cr.changes?.email && cr.userId) await User.updateOne({ _id: cr.userId }, { email: cr.changes.email });
  }
  cr.status = decision === 'approve' ? 'approved' : 'declined';
  cr.decidedBy = c.userId;
  cr.decidedAt = new Date();
  cr.reason = reason;
  await cr.save();
  await audit({ action: `contact_change.${cr.status}`, entityType: 'changeRequest', entityId: id, after: cr.changes, reason });
  return { id, status: cr.status };
}

export { myChildIds, Membership };
