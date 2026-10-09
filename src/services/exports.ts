import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';
import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { notFound, stateConflict } from '../core/errors';
import { me } from '../core/http';
import { daysFromNow } from '../lib/dates';
import { schoolLink } from '../lib/links';
import { enqueue, registerJob } from '../jobs/queue';
import { files, saveGenerated } from '../integrations/storage';
import {
  AcademicSession, AnnualResult, Application, AttendanceRegister, ClassArm, ClassLevel, Enrolment, ExportJob, Guardian, Invoice, Payment, Receipt, Score, Staff, Student, StudentDocument, StudentGuardian, Subject, Term, TermResult
} from '../models';
import { safeCell } from '../core/sanitize';
import { loadSchool, need, ownerRecipients } from './common';
import { notify } from './notify';

/**
 * The school owns its data and can take it away (RPT-03): a full export as an archive with one spreadsheet per record type,
 * and the documents. Only the owner can request it. Money columns are numbers (kobo) so Excel can total them.
 */

const flat = (v: any): any => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (typeof v.toHexString === 'function') return v.toHexString();
    return JSON.stringify(v);
  }
  return safeCell(v);
};

function rowsOf(docs: any[]): { headers: string[]; rows: any[][] } {
  const headers: string[] = [];
  const set = new Set<string>();
  const flatDocs = docs.map((d) => {
    const out: Record<string, any> = {};
    const walk = (o: any, prefix: string, depth: number) => {
      for (const [k, v] of Object.entries(o)) {
        if (k === '__v' || k === 'schoolId' || k === 'passwordHash') continue;
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && typeof (v as any).toHexString !== 'function' && depth < 1) walk(v, key, depth + 1);
        else out[key] = flat(v);
      }
    };
    walk(d, '', 0);
    for (const k of Object.keys(out)) if (!set.has(k)) {
      set.add(k);
      headers.push(k);
    }
    return out;
  });
  return { headers, rows: flatDocs.map((d) => headers.map((h) => d[h] ?? '')) };
}

async function book(name: string, docs: any[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name.slice(0, 31));
  const { headers, rows } = rowsOf(docs);
  ws.addRow(headers.length ? headers : ['(empty)']);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export async function requestExport() {
  const c = me();
  if (await ExportJob.exists({ status: { $in: ['queued', 'running'] } })) throw stateConflict('An export is already being prepared.');
  const doc: any = await ExportJob.create({ kind: 'full', status: 'queued', requestedBy: c.userId });
  const jobId = await enqueue('export-data', { exportId: String(doc._id) }, { schoolId: c.schoolId, userId: c.userId });
  await audit({ action: 'school.export.request', entityType: 'exportJob', entityId: doc._id });
  return { exportId: String(doc._id), jobId };
}

export async function exportStatus(id: string) {
  const e: any = await need(ExportJob.findById(id).lean(), 'Export');
  const expired = e.expiresAt && e.expiresAt < new Date();
  return { id: String(e._id), status: expired ? 'expired' : e.status, requestedAt: e.createdAt, expiresAt: e.expiresAt, url: e.status === 'ready' && !expired ? files.link(e.file, 600) : undefined };
}

registerJob('export-data', async ({ payload, schoolId, progress }) => {
  const ex: any = await ExportJob.findById(payload.exportId);
  if (!ex) return null;
  ex.status = 'running';
  await ex.save();
  try {
    const school: any = await loadSchool(schoolId);
    const sets: Array<[string, any[]]> = [
      ['school', [{ name: school.name, slug: school.slug, status: school.status, address: school.address, phone: school.phone, email: school.email, settings: school.settings }]],
      ['sessions', await AcademicSession.find({}).lean()],
      ['terms', await Term.find({}).lean()],
      ['class_levels', await ClassLevel.find({}).lean()],
      ['class_arms', await ClassArm.find({}).lean()],
      ['subjects', await Subject.find({}).lean()],
      ['students', await Student.find({}).lean()],
      ['guardians', await Guardian.find({}).lean()],
      ['student_guardians', await StudentGuardian.find({}).lean()],
      ['enrolments', await Enrolment.find({}).lean()],
      ['staff', await Staff.find({}).lean()],
      ['invoices', await Invoice.find({}).lean()],
      ['payments', (await Payment.find({}).lean()).map((p: any) => ({ ...p, proofFile: undefined }))],
      ['receipts', await Receipt.find({}).lean()],
      ['scores', await Score.find({}).lean()],
      ['term_results', (await TermResult.find({}).lean()).map((t: any) => ({ ...t, reportCard: undefined }))],
      ['annual_results', await AnnualResult.find({}).lean()],
      ['attendance', (await AttendanceRegister.find({}).lean()).flatMap((r: any) => r.entries.map((e: any) => ({ date: r.date, part: r.part, classArmId: r.classArmId, termId: r.termId, studentId: e.studentId, status: e.status })))],
      ['applications', await Application.find({ status: { $ne: 'draft' } }).lean()]
    ];
    const zip: Record<string, Uint8Array> = {};
    let i = 0;
    for (const [name, docs] of sets) {
      zip[`${name}.xlsx`] = await book(name, docs);
      i += 1;
      await progress((i / (sets.length + 2)) * 70);
    }
    // documents: scanned records and uploaded documents, in one folder per student
    const docs: any[] = await StudentDocument.find({}).lean();
    const students = new Map<string, any>((await Student.find({ _id: { $in: docs.map((d) => d.ownerId) } }).select('admissionNumber').lean()).map((s: any) => [String(s._id), s]));
    for (const d of docs) {
      try {
        const buf = await files.getBuffer(d.file);
        const ext = d.file.split('.').pop();
        zip[`documents/${(students.get(String(d.ownerId))?.admissionNumber ?? 'student').replace(/[^A-Za-z0-9_-]/g, '_')}/${String(d._id)}-${String(d.title).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40)}.${ext}`] = new Uint8Array(buf);
      } catch {
        /* a missing file is skipped: the list is in documents.xlsx */
      }
    }
    zip['documents.xlsx'] = await book('documents', docs.map((d) => ({ ...d, file: undefined })));
    zip['README.txt'] = new TextEncoder().encode(`Full data export for ${school.name}\nCreated ${new Date().toISOString()}\nOne spreadsheet per record type. Money columns end in Kobo and are whole kobo (100 kobo = 1 naira).\nDocuments are in the documents folder, one folder per student.\n`);
    const buf = Buffer.from(zipSync(zip, { level: 6 }));
    const ref = await saveGenerated(String(schoolId), buf, 'application/zip', 'zip');
    ex.status = 'ready';
    ex.file = ref;
    ex.expiresAt = daysFromNow(7);
    await ex.save();
    await notify({ schoolId, event: 'approval_event', to: (await ownerRecipients(String(schoolId))).map((o) => ({ ...o, kind: 'owner' as const })), vars: { title: 'Your data export is ready', body: `Download it from Settings, Data export. It stays for 7 days. ${schoolLink(school.slug, '/portal/staff/settings?tab=export')}` } });
    return { file: ref, entries: Object.keys(zip).length };
  } catch (e) {
    ex.status = 'failed';
    await ex.save();
    throw e;
  }
});

export { getCtx, notFound };
