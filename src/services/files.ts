import { forbidden, notFound, validation } from '../core/errors';
import { me, can } from '../core/http';
import { assertUploadAllowed, files, PURPOSES, refPurpose, refSchoolId, type Purpose } from '../integrations/storage';
import { Application, ExportJob, ImportBatch, Payment, Receipt, StudentDocument, Student, Submission, Task, TermResult, Enrolment } from '../models';
import { hasFullReach, myChildIds, myTeaching, studentAccess } from './reach';
import type { PermissionKey } from '../core/permissions';

/**
 * Who may upload what. The API checks permission and returns parameters fixed to that school's folder and that
 * purpose's limits (Document 3, section 11).
 */
const SIGN_PERMS: Partial<Record<Purpose, PermissionKey[]>> = {
  site_image: ['website.manage'],
  brand_asset: ['school.branding.manage', 'website.manage'],
  student_photo: ['students.profile.manage'],
  student_document: ['students.documents.manage'],
  task_file: ['tasks.manage'],
  submission_file: ['tasks.submit'],
  payment_proof: ['fees.pay', 'fees.payment.record'],
  import_file: ['imports.manage']
};

export async function signUpload(purpose: Purpose, mime: string, size?: number) {
  const c = me();
  const need = SIGN_PERMS[purpose];
  if (!need) throw validation('That upload purpose is not available here.', { purpose: 'Not available.' });
  if (!need.some((k) => c.permissions.has(k))) throw forbidden();
  if (!c.schoolId) throw forbidden('Choose a school first.');
  assertUploadAllowed(purpose, mime, size);
  return files.signUpload({ schoolId: c.schoolId, purpose, mime });
}

/** Confirm a file the browser uploaded: it must exist in this school's folder, for the stated purpose, within limits. */
export async function confirmFile(ref: string, purpose: Purpose) {
  const c = me();
  if (!c.schoolId) throw forbidden();
  await files.confirm(ref, c.schoolId, purpose);
  return ref;
}

export async function confirmMany(refs: string[], purpose: Purpose, max = PURPOSES[purpose].maxFiles ?? 10) {
  if (refs.length > max) throw validation(`You can attach up to ${max} files.`);
  for (const r of refs) await confirmFile(r, purpose);
  return refs;
}

/**
 * A short-lived link to a private file, after a permission and reach check. A ref from another school is
 * the same as a missing file.
 */
export async function privateLink(ref: string) {
  const c = me();
  if (!c.schoolId || refSchoolId(ref) !== c.schoolId) throw notFound('File');
  const purpose = refPurpose(ref);
  if (ref.includes('/pub/')) return { url: files.link(ref), expiresIn: 0 };

  const allowed = await canRead(ref, purpose);
  if (!allowed) throw notFound('File');
  return { url: files.link(ref, 300), expiresIn: 300 };
}

async function canRead(ref: string, purpose: Purpose): Promise<boolean> {
  const c = me();
  switch (purpose) {
    case 'student_photo': {
      const s = await Student.findOne({ photo: ref }).select('_id').lean();
      return !!s && (await studentAccess(String(s._id))) !== 'none';
    }
    case 'student_document': {
      const d = await StudentDocument.findOne({ file: ref }).lean();
      if (!d) return false;
      const access = await studentAccess(String(d.ownerId));
      if (access === 'none') return false;
      if (access === 'children' || access === 'self') return !!d.visibleToGuardian && can('students.documents.view');
      return can('students.documents.view');
    }
    case 'task_file': {
      const t = await Task.findOne({ 'attachments.ref': ref }).lean();
      if (!t) return false;
      if (hasFullReach() || c.roles.includes('principal')) return true;
      if (t.staffId && String(t.staffId) === c.staffId) return true;
      if (t.status !== 'published' && t.status !== 'closed') return false;
      if (c.roles.includes('student') && c.studentId) return !!(await Enrolment.exists({ studentId: c.studentId, classArmId: t.classArmId }));
      if (c.roles.includes('parent')) return !!(await Enrolment.exists({ studentId: { $in: await myChildIds() }, classArmId: t.classArmId }));
      const teach = await myTeaching();
      return teach.arms.has(String(t.classArmId));
    }
    case 'submission_file': {
      const s = await Submission.findOne({ 'files.ref': ref }).lean();
      if (!s) return false;
      const task = await Task.findById(s.taskId).lean();
      if (hasFullReach()) return true;
      if (c.roles.includes('student')) return c.studentId === String(s.studentId);
      if (c.roles.includes('parent')) return (await myChildIds()).includes(String(s.studentId));
      return !!task && String(task.staffId) === c.staffId;
    }
    case 'payment_proof': {
      const p = await Payment.findOne({ proofFile: ref }).lean();
      if (!p) return false;
      if (can('fees.payment.view')) return true;
      return !!p.payerGuardianId && String(p.payerGuardianId) === c.guardianId;
    }
    case 'admission_document': {
      const a = await Application.exists({ 'documents.file': ref });
      return !!a && can('admissions.review');
    }
    case 'import_file':
      return can('imports.manage') && !!(await ImportBatch.exists({ file: ref }));
    case 'generated': {
      const receipt = await Receipt.findOne({ file: ref }).lean();
      if (receipt) {
        if (can('fees.invoice.view') || can('fees.payment.view')) return true;
        return !!receipt.studentId && (await myChildIds()).includes(String(receipt.studentId));
      }
      const tr = await TermResult.findOne({ $or: [{ 'reportCard.file': ref }, { 'reportCard.superseded.file': ref }] }).lean();
      if (tr) return (await studentAccess(String(tr.studentId))) !== 'none' && can('results.published.view');
      const ex = await ExportJob.findOne({ file: ref }).lean();
      if (ex) return can('school.export.request');
      return false;
    }
    default:
      return false;
  }
}
