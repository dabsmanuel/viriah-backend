import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { AppError, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { me } from '../core/http';
import { canAssignRole, STAFF_ROLES } from '../core/permissions';
import { computeSubject, gradeFor } from '../calc/results';
import { enqueue, registerJob } from '../jobs/queue';
import { files, saveGenerated } from '../integrations/storage';
import { isDateString, todayLagos, diffDays } from '../lib/dates';
import { nairaToKobo } from '../lib/money';
import { normalizePhone } from '../lib/phone';
import { round1 } from '../lib/rounding';
import {
  AcademicSession, AttendanceRegister, ClassArm, ClassLevel, Credit, Enrolment, Guardian, ImportBatch, Invoice, Payment, Score, Staff, Student, StudentGuardian, Subject, Term, TermResult, Invite, Membership
} from '../models';
import { armContext, subjectRoster } from './academics';
import { recordOpeningBalances } from './fees';
import { fullName, loadSchool, need } from './common';
import { confirmFile } from './files';
import { addStaff } from './staff';
import { enrolStudent, findDuplicates } from './students';
import { buildTemplate, norm, readTable, type Table } from './tables';
import { currentSession } from './reach';

/**
 * Bulk import of existing students, staff, past results and opening balances (LEG-01 to LEG-05, flow F7).
 * Every import is a batch: validated first, with a report of rows ready, rows with errors and likely duplicates; corrected on
 * screen; committed as a whole; and rolled back as a whole within a set period. An import never sends a message.
 */

export const KINDS = ['students', 'staff', 'past_results', 'opening_balances', 'scores'] as const;
export type Kind = (typeof KINDS)[number];

export interface Row {
  n: number;
  data: Record<string, any>;
  status: 'ready' | 'error' | 'duplicate';
  errors: Array<{ field: string; message: string }>;
  duplicateOf?: string;
  accept?: boolean; // staff confirmed a possible duplicate
}

// ------------------------------------------------------------------ templates

export async function template(kind: Kind, q: { classArmId?: string; subjectId?: string }) {
  const school: any = await loadSchool();
  let buf: Buffer;
  let name: string;
  if (kind === 'students') {
    const levels: any[] = await ClassLevel.find({ active: true }).sort({ order: 1 }).lean();
    const arms: any[] = await ClassArm.find({ active: true }).lean();
    const armNames = [...new Set(arms.map((a) => a.name))].sort();
    buf = await buildTemplate({
      name: 'Students',
      columns: [
        { header: 'Admission number' }, { header: 'First name' }, { header: 'Middle name' }, { header: 'Last name' }, { header: 'Date of birth' },
        { header: 'Gender', list: ['male', 'female'] }, { header: 'Class', list: levels.map((l) => l.name) }, { header: 'Arm', list: armNames },
        { header: 'Address' }, { header: 'State of origin' },
        { header: 'Guardian 1 first name' }, { header: 'Guardian 1 last name' }, { header: 'Guardian 1 phone' }, { header: 'Guardian 1 email' }, { header: 'Guardian 1 relationship' },
        { header: 'Guardian 2 first name' }, { header: 'Guardian 2 last name' }, { header: 'Guardian 2 phone' }, { header: 'Guardian 2 email' }, { header: 'Guardian 2 relationship' }
      ],
      rows: [['', 'Chika', '', 'Okafor', '2015-03-04', 'female', levels[0]?.name ?? 'Primary 4', armNames[0] ?? 'A', '', '', 'Ngozi', 'Okafor', '08031234567', '', 'mother', '', '', '', '', '']],
      notes: 'One row per student, with guardian columns.\nDate of birth: YYYY-MM-DD.\nLeave Admission number empty to have one made in the school format.\nA guardian phone shared by several rows becomes one guardian.\nNothing is sent to parents when you import. Login details go out at Go live.'
    });
    name = 'students-template.xlsx';
  } else if (kind === 'staff') {
    buf = await buildTemplate({ name: 'Staff', columns: [{ header: 'First name' }, { header: 'Last name' }, { header: 'Phone' }, { header: 'Email' }, { header: 'Roles' }], rows: [['Bola', 'Adeyemi', '08035556666', '', 'subject_teacher']], notes: `Roles: ${STAFF_ROLES.join(', ')}. Separate several with commas.\nEach valid row becomes an invite by SMS.` });
    name = 'staff-template.xlsx';
  } else if (kind === 'opening_balances') {
    buf = await buildTemplate({ name: 'Opening balances', columns: [{ header: 'Admission number' }, { header: 'Amount' }, { header: 'Note' }], rows: [['GFS/26/0001', '12000.00', 'Arrears from last session']], notes: 'Amount is in naira. One brought-forward invoice is made for each student.' });
    name = 'opening-balances-template.xlsx';
  } else if (kind === 'past_results') {
    const subjects: any[] = await Subject.find({ active: true }).sort({ name: 1 }).lean();
    buf = await buildTemplate({ name: 'Past results', columns: [{ header: 'Admission number' }, { header: 'Subject', list: subjects.map((s) => s.name) }, { header: 'Total' }, { header: 'CA1' }, { header: 'CA2' }, { header: 'Exam' }], rows: [['GFS/26/0001', subjects[0]?.name ?? 'English Language', '78', '', '', '']], notes: 'Totals only: fill Total.\nFull component scores: fill the component columns instead. These records are labelled as imported and are not recalculated.' });
    name = 'past-results-template.xlsx';
  } else {
    if (!q.classArmId || !q.subjectId) throw validation('Choose the class and the subject for the score template.', { classArmId: 'Required.' });
    const ac = await armContext(q.classArmId);
    const session = await currentSession();
    const term: any = await Term.findOne({ status: 'current' }).lean();
    const roster = session && term ? await subjectRoster(q.classArmId, q.subjectId, String(term._id), session._id) : [];
    const comps = [...(ac.structure?.components ?? [])].sort((a: any, b: any) => a.order - b.order);
    buf = await buildTemplate({ name: 'Scores', columns: [{ header: 'Admission number' }, { header: 'Name' }, ...comps.map((c: any) => ({ header: c.key }))], rows: roster.map((s: any) => [s.admissionNumber, fullName(s), ...comps.map(() => '')]), notes: `Enter scores under each column. Maximums: ${comps.map((c: any) => `${c.key} ${c.max}`).join(', ')}.\nWrite ABS for absent and EXEMPT for an exempt subject.` });
    name = 'scores-template.xlsx';
  }
  const ref = await saveGenerated(String(school._id), buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');
  return { url: files.link(ref, 600), name };
}

// ------------------------------------------------------------------ validation

const get = (c: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) if (c[k] !== undefined && c[k] !== '') return c[k];
  return '';
};

function parseDate(v: string): string | null {
  if (!v) return null;
  if (isDateString(v)) return v;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
  if (m) {
    const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isDateString(d) ? d : null;
  }
  return null;
}

interface Ctx {
  levels: Map<string, any>; // lower name -> level
  armsByLevel: Map<string, any[]>;
  admissionNumbers: Set<string>;
  staffPhones: Set<string>;
  students: Map<string, any>; // admission number -> student
  subjects: Map<string, any>;
  actorRoles: string[];
  options: any;
  structureKeys?: Array<{ key: string; name: string; max: number }>;
}

async function buildCtx(kind: Kind, options: any, actorRoles: string[]): Promise<Ctx> {
  const levels: any[] = await ClassLevel.find({ active: true }).lean();
  const arms: any[] = await ClassArm.find({ active: true }).lean();
  const ctx: Ctx = { levels: new Map(levels.map((l) => [l.name.toLowerCase(), l])), armsByLevel: new Map(), admissionNumbers: new Set(), staffPhones: new Set(), students: new Map(), subjects: new Map(), actorRoles, options };
  for (const a of arms) ctx.armsByLevel.set(String(a.classLevelId), [...(ctx.armsByLevel.get(String(a.classLevelId)) ?? []), a]);
  if (kind === 'students') ctx.admissionNumbers = new Set((await Student.find({}).select('admissionNumber').lean()).map((s: any) => s.admissionNumber));
  if (kind === 'staff') ctx.staffPhones = new Set((await Staff.find({}).select('phone').lean()).map((s: any) => s.phone));
  if (kind === 'opening_balances' || kind === 'past_results') {
    for (const s of await Student.find({}).select('admissionNumber firstName lastName').lean()) ctx.students.set((s as any).admissionNumber.toUpperCase(), s);
  }
  if (kind === 'past_results') {
    for (const s of await Subject.find({}).lean()) ctx.subjects.set((s as any).name.toLowerCase(), s);
    if (options.classArmId) {
      const ac = await armContext(options.classArmId).catch(() => null);
      ctx.structureKeys = ac?.structure ? [...ac.structure.components].sort((a: any, b: any) => a.order - b.order) : [];
    }
  }
  return ctx;
}

async function validateRow(kind: Kind, n: number, c: Record<string, string>, ctx: Ctx): Promise<Row> {
  const errors: Row['errors'] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  let data: Record<string, any> = {};

  if (kind === 'students') {
    data = {
      admissionNumber: get(c, 'admissionnumber', 'admissionno', 'admno').toUpperCase(),
      firstName: get(c, 'firstname'),
      middleName: get(c, 'middlename'),
      lastName: get(c, 'lastname'),
      dob: parseDate(get(c, 'dateofbirth', 'dob')),
      gender: ({ male: 'male', m: 'male', female: 'female', f: 'female' } as Record<string, string>)[get(c, 'gender').toLowerCase()],
      className: get(c, 'class', 'classlevel'),
      armName: get(c, 'arm'),
      address: get(c, 'address'),
      stateOfOrigin: get(c, 'stateoforigin'),
      guardians: [1, 2]
        .map((i) => ({ firstName: get(c, `guardian${i}firstname`), lastName: get(c, `guardian${i}lastname`), phone: normalizePhone(get(c, `guardian${i}phone`)) ?? get(c, `guardian${i}phone`), email: get(c, `guardian${i}email`), relationship: get(c, `guardian${i}relationship`) || 'parent' }))
        .filter((g) => g.firstName || g.lastName || g.phone)
    };
    if (!data.firstName) err('First name', 'First name is required.');
    if (!data.lastName) err('Last name', 'Last name is required.');
    if (!data.dob) err('Date of birth', 'Use the format YYYY-MM-DD.');
    if (!data.gender) err('Gender', 'Write male or female.');
    const level = ctx.levels.get(String(data.className).toLowerCase());
    if (!level) err('Class', `There is no class called "${data.className}".`);
    else {
      const arms = ctx.armsByLevel.get(String(level._id)) ?? [];
      const arm = data.armName ? arms.find((a) => a.name.toLowerCase() === data.armName.toLowerCase()) : arms.length === 1 ? arms[0] : undefined;
      if (!arm) err('Arm', data.armName ? `${level.name} has no arm called "${data.armName}".` : `Say which arm of ${level.name}.`);
      else data.classArmId = String(arm._id);
    }
    if (!data.guardians.length) err('Guardian 1 phone', 'Every student needs a guardian.');
    data.guardians.forEach((g: any, i: number) => {
      if (!g.firstName || !g.lastName) err(`Guardian ${i + 1} name`, 'Give the guardian’s first and last name.');
      if (!normalizePhone(String(g.phone))) err(`Guardian ${i + 1} phone`, 'Enter a valid phone number.');
    });
    if (data.admissionNumber && ctx.admissionNumbers.has(data.admissionNumber)) err('Admission number', 'That admission number is already used.');
  } else if (kind === 'staff') {
    data = { firstName: get(c, 'firstname'), lastName: get(c, 'lastname'), phone: normalizePhone(get(c, 'phone')), email: get(c, 'email').toLowerCase(), roles: get(c, 'roles').split(/[,;]/).map((r) => r.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean) };
    if (!data.firstName || !data.lastName) err('Name', 'Give the first and last name.');
    if (!data.phone) err('Phone', 'Enter a valid phone number.');
    else if (ctx.staffPhones.has(data.phone)) err('Phone', 'A staff member with this phone number already exists.');
    if (!data.roles.length) err('Roles', 'Give at least one role.');
    for (const r of data.roles) {
      if (!STAFF_ROLES.includes(r)) err('Roles', `${r} is not a staff role.`);
      else if (!canAssignRoleFor(ctx.actorRoles, r)) err('Roles', `You cannot assign the ${r.replace(/_/g, ' ')} role.`);
    }
  } else if (kind === 'opening_balances') {
    const adm = get(c, 'admissionnumber', 'admissionno').toUpperCase();
    data = { admissionNumber: adm, note: get(c, 'note') };
    const s = ctx.students.get(adm);
    if (!s) err('Admission number', `No student has the admission number ${adm || '(blank)'}.`);
    else data.studentId = String(s._id);
    try {
      data.amountKobo = nairaToKobo(get(c, 'amount'));
      if (data.amountKobo <= 0) err('Amount', 'Enter an amount above zero.');
    } catch {
      err('Amount', 'Enter the amount in naira, for example 12000.50.');
    }
  } else if (kind === 'past_results') {
    const adm = get(c, 'admissionnumber', 'admissionno').toUpperCase();
    data = { admissionNumber: adm, subject: get(c, 'subject') };
    const s = ctx.students.get(adm);
    if (!s) err('Admission number', `No student has the admission number ${adm || '(blank)'}.`);
    else data.studentId = String(s._id);
    const subject = ctx.subjects.get(String(data.subject).toLowerCase());
    if (!subject) err('Subject', `There is no subject called "${data.subject}".`);
    else data.subjectId = String(subject._id);
    if (ctx.options.mode === 'components') {
      data.components = {};
      for (const k of ctx.structureKeys ?? []) {
        const raw = get(c, norm(k.key), norm(k.name));
        if (raw === '') continue;
        if (raw.toUpperCase() === 'ABS') continue;
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || v > k.max) err(k.key, `${k.name ?? k.key} is marked out of ${k.max}.`);
        else data.components[k.key] = v;
      }
      if (!Object.keys(data.components).length) err('Scores', 'Enter at least one component score.');
    } else {
      const v = Number(get(c, 'total'));
      if (!Number.isFinite(v) || v < 0 || v > 100) err('Total', 'Enter a total from 0 to 100.');
      else data.total = round1(v);
    }
  }
  return { n, data, status: errors.length ? 'error' : 'ready', errors };
}

const canAssignRoleFor = (actorRoles: string[], role: string) => canAssignRole(actorRoles, role);

/** Duplicates inside the file, and against records already in the school. */
async function markDuplicates(kind: Kind, rows: Row[]) {
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.status === 'error') continue;
    const d = r.data;
    let key: string | null = null;
    if (kind === 'students') key = [d.firstName, d.lastName, d.dob, d.guardians?.[0]?.phone].map((x) => String(x).toLowerCase()).join('|');
    else if (kind === 'staff') key = String(d.phone);
    else if (kind === 'opening_balances') key = String(d.studentId);
    else if (kind === 'past_results') key = `${d.studentId}:${d.subjectId}`;
    if (key) {
      if (seen.has(key)) {
        if (kind === 'students') {
          r.status = 'duplicate';
          r.duplicateOf = `Same as row ${seen.get(key)} in this file.`;
        } else {
          r.status = 'error';
          r.errors.push({ field: 'Row', message: `Repeats row ${seen.get(key)}.` });
        }
      } else seen.set(key, r.n);
    }
    if (kind === 'students' && r.status === 'ready') {
      const dup = await findDuplicates({ firstName: d.firstName, lastName: d.lastName, dob: d.dob }, d.guardians?.[0]?.phone);
      if (dup.students.length) {
        r.status = 'duplicate';
        r.duplicateOf = `Looks like ${dup.students[0].name} (${dup.students[0].admissionNumber}) who is already in the school.`;
      }
    }
  }
}

function counts(rows: Row[], committed = 0) {
  return { total: rows.length, ready: rows.filter((r) => r.status === 'ready').length, errors: rows.filter((r) => r.status === 'error').length, duplicates: rows.filter((r) => r.status === 'duplicate').length, committed };
}

registerJob('import-validate', async ({ payload }) => {
  const batch: any = await ImportBatch.findById(payload.batchId);
  if (!batch) return null;
  try {
    const table = await readTable(batch.file);
    const ctx = await buildCtx(batch.kind, batch.options ?? {}, payload.actorRoles ?? []);
    const rows: Row[] = [];
    for (const t of table.rows) rows.push(await validateRow(batch.kind, t.n, t.cells, ctx));
    await markDuplicates(batch.kind, rows);
    batch.rows = rows;
    batch.counts = counts(rows);
    batch.status = 'ready';
    batch.markModified('rows');
    await batch.save();
    return batch.counts;
  } catch (e) {
    batch.status = 'failed';
    batch.issues = [{ row: 0, field: 'file', message: (e as Error).message }];
    await batch.save();
    throw e;
  }
});

export async function startImport(input: { kind: Kind; fileRef: string; options?: any }) {
  const c = me();
  if (input.kind === 'scores') throw validation('Score sheets are uploaded on the score sheet itself.', { kind: 'Use the score sheet upload.' });
  if (c.roles.includes('bursar') && !['opening_balances'].includes(input.kind) && !c.roles.some((r) => ['owner', 'principal', 'school_admin'].includes(r))) throw new AppError('forbidden', 'The bursar can import opening balances only.');
  await confirmFile(input.fileRef, 'import_file');
  const options = input.options ?? {};
  if (input.kind === 'past_results') {
    if (!options.sessionName || !/^\d{4}\/\d{4}$/.test(options.sessionName)) throw validation('Give the past session as two years, for example 2024/2025.', { 'options.sessionName': 'Required.' });
    if (![1, 2, 3].includes(options.termNumber)) throw validation('Choose the term, 1 to 3.', { 'options.termNumber': 'Required.' });
    if (!options.classArmId) throw validation('Choose the class the students were in.', { 'options.classArmId': 'Required.' });
    if (!['totals', 'components'].includes(options.mode)) throw validation('Choose totals only or full component scores.', { 'options.mode': 'Required.' });
    await need(ClassArm.findById(options.classArmId).lean(), 'Class');
  }
  const batch: any = await ImportBatch.create({ kind: input.kind, file: input.fileRef, status: 'validating', options, createdBy: c.userId });
  const jobId = await enqueue('import-validate', { batchId: String(batch._id), actorRoles: c.roles }, { schoolId: c.schoolId, userId: c.userId });
  return { batchId: String(batch._id), jobId };
}

const view = (b: any) => ({ id: String(b._id), kind: b.kind, status: b.status, counts: b.counts, options: b.options, createdAt: b.createdAt, committedAt: b.committedAt, rolledBackAt: b.rolledBackAt, issues: b.issues });

export async function listBatches() {
  return (await ImportBatch.find({}).sort({ createdAt: -1 }).limit(100).select('-rows').lean()).map(view);
}

export async function batchReport(id: string, tab?: 'ready' | 'errors' | 'duplicates') {
  const b: any = await need(ImportBatch.findById(id).lean(), 'Import');
  const rows: Row[] = b.rows ?? [];
  const pick = tab === 'ready' ? rows.filter((r) => r.status === 'ready') : tab === 'errors' ? rows.filter((r) => r.status === 'error') : tab === 'duplicates' ? rows.filter((r) => r.status === 'duplicate') : rows;
  return { ...view(b), rows: pick.slice(0, 1000).map((r) => ({ n: r.n, status: r.status, errors: r.errors, duplicateOf: r.duplicateOf, accept: !!r.accept, data: r.data })) };
}

/** Correct one row on screen and revalidate it. */
export async function fixRow(id: string, rowNumber: number, cells: Record<string, string>, accept?: boolean) {
  const b: any = await need(ImportBatch.findById(id), 'Import');
  if (b.status !== 'ready') throw stateConflict('This import is not waiting for review.');
  const rows: Row[] = b.rows;
  const idx = rows.findIndex((r) => r.n === rowNumber);
  if (idx < 0) throw notFound('Row');
  if (accept !== undefined && !Object.keys(cells).length) {
    rows[idx].accept = accept;
  } else {
    const ctx = await buildCtx(b.kind, b.options ?? {}, me().roles);
    const merged: Record<string, string> = {};
    // Rebuild the raw cells from what the row already holds so a small fix revalidates the whole row.
    Object.assign(merged, rawCells(b.kind, rows[idx].data), Object.fromEntries(Object.entries(cells).map(([k, v]) => [norm(k), v])));
    const fresh = await validateRow(b.kind, rowNumber, merged, ctx);
    fresh.accept = accept ?? rows[idx].accept;
    rows[idx] = fresh;
    await markDuplicates(b.kind, rows.map((r, i) => (i === idx ? r : { ...r, status: r.status === 'duplicate' ? 'ready' : r.status, errors: r.errors })) as Row[]).catch(() => undefined);
  }
  b.rows = rows;
  b.counts = counts(rows, b.counts?.committed ?? 0);
  b.markModified('rows');
  await b.save();
  return rows[idx];
}

function rawCells(kind: Kind, d: Record<string, any>): Record<string, string> {
  if (kind === 'students') {
    const out: Record<string, string> = { admissionnumber: d.admissionNumber ?? '', firstname: d.firstName ?? '', middlename: d.middleName ?? '', lastname: d.lastName ?? '', dateofbirth: d.dob ?? '', gender: d.gender ?? '', class: d.className ?? '', arm: d.armName ?? '', address: d.address ?? '', stateoforigin: d.stateOfOrigin ?? '' };
    (d.guardians ?? []).forEach((g: any, i: number) => Object.assign(out, { [`guardian${i + 1}firstname`]: g.firstName, [`guardian${i + 1}lastname`]: g.lastName, [`guardian${i + 1}phone`]: g.phone ?? '', [`guardian${i + 1}email`]: g.email ?? '', [`guardian${i + 1}relationship`]: g.relationship ?? '' }));
    return out;
  }
  if (kind === 'staff') return { firstname: d.firstName ?? '', lastname: d.lastName ?? '', phone: d.phone ?? '', email: d.email ?? '', roles: (d.roles ?? []).join(',') };
  if (kind === 'opening_balances') return { admissionnumber: d.admissionNumber ?? '', amount: d.amountKobo ? String(d.amountKobo / 100) : '', note: d.note ?? '' };
  return { admissionnumber: d.admissionNumber ?? '', subject: d.subject ?? '', total: d.total !== undefined ? String(d.total) : '', ...Object.fromEntries(Object.entries(d.components ?? {}).map(([k, v]) => [norm(k), String(v)])) };
}

// ------------------------------------------------------------------ commit

export async function startCommit(id: string) {
  const c = me();
  const b: any = await need(ImportBatch.findById(id), 'Import');
  assertTransition('importBatch', b.status, 'committed', 'This import');
  if (!b.counts?.ready && !(b.rows ?? []).some((r: Row) => r.status === 'duplicate' && r.accept)) throw stateConflict('There are no valid rows to save. Fix the errors first.');
  return enqueue('import-commit', { batchId: id, actorRoles: c.roles, permissions: [...c.permissions] }, { schoolId: c.schoolId, userId: c.userId, uniqueKey: `import-commit:${id}` });
}

registerJob('import-commit', async ({ payload, userId, progress }) => {
  const ctx = getCtx()!;
  ctx.userId = userId;
  ctx.roles = payload.actorRoles ?? [];
  ctx.permissions = new Set(payload.permissions ?? []);
  const batch: any = await ImportBatch.findById(payload.batchId);
  if (!batch || batch.status === 'committed') return null;
  const rows: Row[] = batch.rows;
  const todo = rows.filter((r) => r.status === 'ready' || (r.status === 'duplicate' && r.accept));
  const created: Record<string, any[]> = { students: [], guardians: [], enrolments: [], staff: [], invoices: [], scores: [], termResults: [], sessions: [] };
  let done = 0;
  const failed: Array<{ row: number; message: string }> = [];

  if (batch.kind === 'students') {
    const session = await currentSession();
    if (!session) throw new Error('There is no current session to place students in.');
    for (const r of todo) {
      try {
        const d = r.data;
        const out = await enrolStudent(
          {
            child: { firstName: d.firstName, middleName: d.middleName || undefined, lastName: d.lastName, dob: d.dob, gender: d.gender, address: d.address || undefined, stateOfOrigin: d.stateOfOrigin || undefined },
            guardians: d.guardians.map((g: any, i: number) => ({ firstName: g.firstName, lastName: g.lastName, phone: g.phone, email: g.email || undefined, relationship: g.relationship, isPrimary: i === 0, isFeePayer: i === 0 })),
            classArmId: d.classArmId,
            consent: { onFile: true, source: 'import', at: new Date() }, // the school confirms it holds consent
            admissionNumber: d.admissionNumber || undefined,
            importBatchId: String(batch._id)
          },
          { sendLogins: false }
        );
        created.students.push(String(out.student._id));
        created.enrolments.push(String(out.enrolment._id));
        for (const g of out.guardians) if (String(g.importBatchId ?? '') === String(batch._id)) created.guardians.push(String(g._id));
      } catch (e) {
        failed.push({ row: r.n, message: (e as Error).message });
      }
      done += 1;
      if (done % 20 === 0) await progress((done / todo.length) * 95);
    }
  } else if (batch.kind === 'staff') {
    for (const r of todo) {
      try {
        const out = await addStaff({ firstName: r.data.firstName, lastName: r.data.lastName, phone: r.data.phone, email: r.data.email || undefined, roles: r.data.roles });
        created.staff.push(String(out.staff._id));
      } catch (e) {
        failed.push({ row: r.n, message: (e as Error).message });
      }
    }
  } else if (batch.kind === 'opening_balances') {
    const out = await recordOpeningBalances(todo.map((r) => ({ studentId: r.data.studentId, amountKobo: r.data.amountKobo, note: r.data.note })), String(batch._id));
    const inv = await Invoice.find({ importBatchId: batch._id }).select('_id').lean();
    created.invoices = inv.map((i: any) => String(i._id));
    if (out.skipped) failed.push({ row: 0, message: `${out.skipped} student${out.skipped === 1 ? ' already has' : 's already have'} an opening balance, so they were skipped.` });
  } else if (batch.kind === 'past_results') {
    const out = await writeLegacy(
      { sessionName: batch.options.sessionName, termNumber: batch.options.termNumber, classArmId: batch.options.classArmId, mode: batch.options.mode, rows: todo.map((r) => ({ n: r.n, studentId: r.data.studentId, subjectId: r.data.subjectId, total: r.data.total, components: r.data.components })) },
      String(batch._id)
    );
    created.scores = out.scoreIds;
    created.termResults = out.termResultIds;
    created.enrolments = out.enrolmentIds;
    created.sessions = out.sessionId ? [out.sessionId] : [];
    failed.push(...out.failed);
  }

  batch.status = 'committed';
  batch.committedAt = new Date();
  batch.createdIds = created;
  batch.counts = { ...counts(rows), committed: todo.length - failed.length };
  batch.issues = failed.map((f) => ({ row: f.row, field: 'commit', message: f.message }));
  batch.markModified('createdIds');
  await batch.save();
  await audit({ action: 'imports.commit', entityType: 'importBatch', entityId: batch._id, after: { kind: batch.kind, committed: batch.counts.committed, failed: failed.length } });
  return batch.counts;
});

// ------------------------------------------------------------------ rollback

/**
 * Roll back a whole batch within the school's period (14 days by default), as long as no payment or new result has been
 * recorded against its students.
 */
export async function rollback(id: string) {
  const b: any = await need(ImportBatch.findById(id), 'Import');
  assertTransition('importBatch', b.status, 'rolled_back', 'This import');
  const school: any = await loadSchool();
  const days = school.settings?.rollbackDays ?? 14;
  if (b.committedAt && diffDays(todayLagos(), b.committedAt.toISOString().slice(0, 10)) > days) throw stateConflict(`This import is more than ${days} days old, so it can no longer be rolled back.`);
  const ids = b.createdIds ?? {};
  const students: string[] = ids.students ?? [];

  if (b.kind === 'students' && students.length) {
    const [pay, entered, att, results] = await Promise.all([
      Payment.exists({ 'allocations.studentId': { $in: students }, status: { $in: ['successful', 'pending_confirmation'] } }),
      Score.exists({ studentId: { $in: students }, source: { $ne: 'imported' } }),
      AttendanceRegister.exists({ 'entries.studentId': { $in: students } }),
      TermResult.exists({ studentId: { $in: students }, source: { $ne: 'imported' } })
    ]);
    if (pay || entered || att || results) throw stateConflict('A payment, score or register has been recorded for some of these students, so the import cannot be rolled back.', { payments: !!pay, scores: !!entered || !!results, attendance: !!att });
    await Invoice.deleteMany({ studentId: { $in: students } });
    await Credit.deleteMany({ studentId: { $in: students } });
    await Enrolment.deleteMany({ studentId: { $in: students } });
    await StudentGuardian.deleteMany({ studentId: { $in: students } });
    await Student.deleteMany({ _id: { $in: students } });
    const gIds: string[] = ids.guardians ?? [];
    for (const g of gIds) if (!(await StudentGuardian.exists({ guardianId: g }))) await Guardian.deleteOne({ _id: g });
  } else if (b.kind === 'staff') {
    const staff: any[] = await Staff.find({ _id: { $in: ids.staff ?? [] } }).lean();
    if (staff.some((s) => s.userId && s.status === 'active')) throw stateConflict('Some of these staff already accepted their invite, so the import cannot be rolled back.');
    await Invite.deleteMany({ staffId: { $in: ids.staff ?? [] } });
    await Membership.deleteMany({ staffId: { $in: ids.staff ?? [] } });
    await Staff.deleteMany({ _id: { $in: ids.staff ?? [] } });
  } else if (b.kind === 'opening_balances') {
    const inv: any[] = await Invoice.find({ importBatchId: b._id }).lean();
    if (inv.some((i) => i.paidKobo > 0)) throw stateConflict('Some of these balances already have payments, so the import cannot be rolled back.');
    await Invoice.deleteMany({ importBatchId: b._id });
  } else if (b.kind === 'past_results') {
    await Score.deleteMany({ importBatchId: b._id });
    await TermResult.deleteMany({ importBatchId: b._id });
    await Enrolment.deleteMany({ _id: { $in: ids.enrolments ?? [] } });
    for (const sid of ids.sessions ?? []) {
      const used = (await Enrolment.exists({ sessionId: sid })) || (await Score.exists({ termId: { $in: (await Term.find({ sessionId: sid }).select('_id').lean()).map((t: any) => t._id) } }));
      if (!used) {
        await Term.deleteMany({ sessionId: sid });
        await AcademicSession.deleteOne({ _id: sid });
      }
    }
  }
  b.status = 'rolled_back';
  b.rolledBackAt = new Date();
  await b.save();
  await audit({ action: 'imports.rollback', entityType: 'importBatch', entityId: id, after: { kind: b.kind } });
  return b;
}

// ------------------------------------------------------------------ past results (imported, never recalculated)

export interface LegacyInput {
  sessionName: string;
  termNumber: 1 | 2 | 3;
  classArmId: string;
  mode: 'totals' | 'components';
  rows: Array<{ n?: number; studentId: string; subjectId: string; total?: number; components?: Record<string, number> }>;
}

/**
 * Past sessions are created as closed sessions that hold imported records only. Results are labelled imported and are never
 * recalculated: compiling the current term does not touch them.
 */
export async function writeLegacy(input: LegacyInput, importBatchId?: string) {
  const ac = await armContext(input.classArmId);
  const comps = ac.structure ? [...ac.structure.components].sort((a: any, b: any) => a.order - b.order) : [];
  let session: any = await AcademicSession.findOne({ name: input.sessionName });
  const createdSessionIds: string[] = [];
  if (!session) {
    session = await AcademicSession.create({ name: input.sessionName, status: 'closed', importedOnly: true });
    for (const n of [1, 2, 3]) await Term.create({ sessionId: session._id, number: n, status: 'closed' });
    createdSessionIds.push(String(session._id));
  }
  const term: any = await Term.findOne({ sessionId: session._id, number: input.termNumber });
  if (!term) throw notFound('Term');

  const out = { scoreIds: [] as string[], termResultIds: [] as string[], enrolmentIds: [] as string[], failed: [] as Array<{ row: number; message: string }>, sessionId: createdSessionIds[0] };
  const byStudent = new Map<string, LegacyInput['rows']>();
  for (const r of input.rows) byStudent.set(r.studentId, [...(byStudent.get(r.studentId) ?? []), r]);

  for (const [studentId, rows] of byStudent) {
    // a real (not imported) result for this student and term is never overwritten
    if ((await TermResult.exists({ termId: term._id, studentId, source: { $ne: 'imported' } })) || (await Score.exists({ termId: term._id, studentId, source: { $ne: 'imported' } }))) {
      out.failed.push({ row: rows[0].n ?? 0, message: 'This student already has a real result for that term, so the imported one was skipped.' });
      continue;
    }
    if (!(await Enrolment.exists({ studentId, sessionId: session._id }))) {
      const e = await Enrolment.create({ studentId, sessionId: session._id, classLevelId: ac.level._id, classArmId: input.classArmId, imported: true });
      out.enrolmentIds.push(String(e._id));
    }
    const totals: number[] = [];
    for (const r of rows) {
      let total: number | null;
      let components: Record<string, number> = {};
      if (input.mode === 'components') {
        components = r.components ?? {};
        total = round1(Object.values(components).reduce((a, b) => a + b, 0));
      } else total = r.total ?? null;
      if (total === null) continue;
      const g = ac.scale ? gradeFor(total, ac.scale) : { grade: null, remark: null };
      const doc: any = await Score.findOneAndUpdate(
        { termId: term._id, subjectId: r.subjectId, studentId },
        { $set: { classArmId: input.classArmId, components, total, grade: g.grade, remark: g.remark, source: 'imported', importBatchId, absent: [], exempt: false } },
        { upsert: true, new: true }
      );
      out.scoreIds.push(String(doc._id));
      totals.push(total);
    }
    if (totals.length) {
      const sum = round1(totals.reduce((a, b) => a + b, 0));
      const tr: any = await TermResult.findOneAndUpdate(
        { termId: term._id, studentId },
        { $set: { classArmId: input.classArmId, subjectsCount: totals.length, total: sum, average: sum / totals.length, source: 'imported', published: true, importBatchId } },
        { upsert: true, new: true }
      );
      out.termResultIds.push(String(tr._id));
    }
  }
  void computeSubject;
  return out;
}

export async function legacyResults(studentId: string) {
  await need(Student.findById(studentId).select('_id').lean(), 'Student');
  const trs: any[] = await TermResult.find({ studentId, source: 'imported' }).lean();
  const terms = new Map<string, any>((await Term.find({ _id: { $in: trs.map((t) => t.termId) } }).lean()).map((t: any) => [String(t._id), t]));
  const sessions = new Map<string, any>((await AcademicSession.find({ _id: { $in: [...terms.values()].map((t) => t.sessionId) } }).lean()).map((s: any) => [String(s._id), s]));
  const out: any[] = [];
  for (const tr of trs) {
    const term = terms.get(String(tr.termId));
    const scores: any[] = await Score.find({ termId: tr.termId, studentId }).lean();
    const subs = new Map<string, any>((await Subject.find({ _id: { $in: scores.map((s) => s.subjectId) } }).lean()).map((s: any) => [String(s._id), s]));
    out.push({ session: sessions.get(String(term?.sessionId))?.name, term: term?.number, imported: true, average: tr.average, total: tr.total, subjects: scores.map((s) => ({ subject: subs.get(String(s.subjectId))?.name, total: s.total, grade: s.grade, components: s.components })) });
  }
  return out;
}

export { Row as ImportRow, loadSchool };
export type { Table };
