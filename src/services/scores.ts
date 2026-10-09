import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { AppError, forbidden, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { can, me } from '../core/http';
import { checkComponentScore, computeSubject, type Component, type GradingScale } from '../calc/results';
import { round1 } from '../lib/rounding';
import { files } from '../integrations/storage';
import { ClassArm, ClassResult, ClassSubject, Score, ScoreSheet, Staff, Subject, TeachingAssignment, Term } from '../models';
import { armContext, armStudents, assertTermOpen, subjectRoster } from './academics';
import { fullName, need } from './common';
import { confirmFile } from './files';
import { notify } from './notify';
import { assertClassTeacherOf, currentSession, hasFullReach, myTeaching, resolveTerm } from './reach';
import { classNames } from './students';
import { photoUrl } from './common';

/** Score entry for each class arm, subject and term (RES-01, RES-02, RES-14, flow F13). */

export interface SheetCtx {
  term: any;
  arm: any;
  level: any;
  group: any;
  scale: GradingScale & any;
  structure: any;
  components: Component[];
  subject: any;
  roster: any[];
}

/** The terms of reference for one subject sheet. */
export async function sheetContext(armId: string, subjectId: string, termId?: string): Promise<SheetCtx> {
  const term: any = await resolveTerm(termId);
  const ac = await armContext(armId);
  if (!ac.scale || !ac.structure) throw validation('The grading scale or assessment structure for this class is not set yet.', { classArmId: 'Set the grading and assessment structure first.' });
  const subject: any = await need(Subject.findById(subjectId).lean(), 'Subject');
  const cs = await ClassSubject.findOne({ classLevelId: ac.level._id, subjectId }).lean();
  if (!cs) throw notFound('Subject');
  const roster = await subjectRoster(armId, subjectId, String(term._id), term.sessionId);
  return { term, arm: ac.arm, level: ac.level, group: ac.group, scale: ac.scale, structure: ac.structure, components: [...ac.structure.components].sort((a: any, b: any) => a.order - b.order), subject, roster };
}

/**
 * Who may open a sheet. The subject's teacher always. The class teacher of the arm, the principal and the owner may look
 * (the class teacher sees the whole class result). A school admin with the "enter scores on behalf" extra may type for teachers.
 */
export async function sheetAccess(armId: string, subjectId: string, mode: 'view' | 'enter') {
  const c = me();
  const t = await myTeaching();
  const teaches = !!t.subjectsByArm.get(armId)?.has(subjectId);
  if (teaches) return { onBehalf: false };
  if (mode === 'view') {
    if (t.classTeacherArms.has(armId) || hasFullReach() || c.roles.includes('principal')) return { onBehalf: false };
  } else if (can('scores.enter') && hasFullReach() && !c.roles.includes('principal') && !c.roles.includes('owner')) {
    return { onBehalf: true };
  }
  throw mode === 'view' ? notFound('Score sheet') : forbidden('You do not teach this subject in this class.');
}

async function getOrCreateSheet(termId: unknown, armId: string, subjectId: string) {
  const assignment: any = await TeachingAssignment.findOne({ classArmId: armId, subjectId, kind: 'subject_teacher' }).lean();
  await ScoreSheet.updateOne({ termId, classArmId: armId, subjectId }, { $setOnInsert: { termId, classArmId: armId, subjectId, staffId: assignment?.staffId, status: 'draft' } }, { upsert: true });
  return ScoreSheet.findOne({ termId, classArmId: armId, subjectId }) as Promise<any>;
}

/** The result cannot change once it is approved or published. Reopen it first. */
export async function assertResultEditable(termId: unknown, armId: string) {
  const cr: any = await ClassResult.findOne({ termId, classArmId: armId }).lean();
  if (cr && ['awaiting_approval', 'approved', 'published'].includes(cr.status)) {
    throw new AppError('result_locked', cr.status === 'published' ? 'The result is published. Ask the principal to reopen it.' : 'The class result is with the principal. It cannot change until it is returned.');
  }
}

const rowOf = (cell: any, components: Component[], scale: GradingScale) => {
  const r = computeSubject({ components: cell?.components ?? {}, absent: cell?.absent ?? [], exempt: !!cell?.exempt }, components, scale);
  return { total: r.total, grade: r.grade, remark: r.remark, complete: r.complete, exempt: r.exempt };
};

export async function getSheet(armId: string, subjectId: string, termId?: string) {
  const ctx = await sheetContext(armId, subjectId, termId);
  await sheetAccess(armId, subjectId, 'view');
  const sheet = await getOrCreateSheet(ctx.term._id, armId, subjectId);
  const scores: any[] = await Score.find({ termId: ctx.term._id, subjectId, studentId: { $in: ctx.roster.map((s) => s._id) } }).lean();
  const byStudent = new Map<string, any>(scores.map((s) => [String(s.studentId), s]));
  const teacher: any = sheet.staffId ? await Staff.findById(sheet.staffId).select('firstName lastName').lean() : null;
  return {
    termId: String(ctx.term._id),
    classArmId: armId,
    subjectId,
    subject: ctx.subject.name,
    status: sheet.status,
    returnNote: sheet.returnNote,
    submittedAt: sheet.submittedAt,
    teacher: teacher ? fullName(teacher) : null,
    components: ctx.components.map((c) => ({ key: c.key, name: c.name, max: c.max })),
    gradingScale: { passMark: ctx.scale.passMark, bands: ctx.scale.bands },
    students: ctx.roster.map((s) => {
      const cell = byStudent.get(String(s._id));
      return { studentId: String(s._id), name: fullName(s), admissionNumber: s.admissionNumber, photoUrl: photoUrl(s.photo), components: cell?.components ?? {}, absent: cell?.absent ?? [], onBehalf: !!cell?.onBehalfOf, ...rowOf(cell, ctx.components, ctx.scale), exempt: !!cell?.exempt };
    })
  };
}

export interface CellInput {
  studentId: string;
  component?: string;
  score?: number | null;
  absent?: boolean;
  exempt?: boolean;
}

/**
 * Save changed cells. Accepts a partial list so autosave stays small. Every cell is checked against the component
 * maximum, and if any are refused nothing is saved, so a retry after a dropped connection is safe.
 */
export async function saveCells(armId: string, subjectId: string, termId: string | undefined, cells: CellInput[]) {
  const c = me();
  const ctx = await sheetContext(armId, subjectId, termId);
  const access = await sheetAccess(armId, subjectId, 'enter');
  await assertTermOpen(ctx.term._id);
  await assertResultEditable(ctx.term._id, armId);
  const sheet = await getOrCreateSheet(ctx.term._id, armId, subjectId);
  if (sheet.status === 'submitted') throw stateConflict('This score sheet is submitted. Ask the class teacher to return it if something needs to change.');

  const roster = new Set(ctx.roster.map((s) => String(s._id)));
  const comp = new Map(ctx.components.map((x) => [x.key, x]));
  const problems: Record<string, string> = {};
  cells.forEach((cell, i) => {
    if (!roster.has(cell.studentId)) problems[`cells[${i}].studentId`] = 'This student does not offer this subject in this class.';
    if (cell.component !== undefined) {
      const k = comp.get(cell.component);
      if (!k) problems[`cells[${i}].component`] = 'This is not a column on the sheet.';
      else if (typeof cell.score === 'number') {
        const bad = checkComponentScore(cell.score, k.max);
        if (bad) problems[`cells[${i}].score`] = bad === `Marked out of ${k.max}.` ? `${k.name ?? k.key} is marked out of ${k.max}.` : bad;
      }
    } else if (cell.exempt === undefined) problems[`cells[${i}]`] = 'Say which column, or whether the subject is exempt.';
  });
  if (Object.keys(problems).length) {
    // The shape the API document shows: { "cells[2].score": "Exam is marked out of 60." }
    throw new AppError('validation_failed', Object.values(problems)[0], { fields: problems });
  }

  const byStudent = new Map<string, CellInput[]>();
  for (const cell of cells) byStudent.set(cell.studentId, [...(byStudent.get(cell.studentId) ?? []), cell]);
  const edited = sheet.status === 'returned';
  const assignment: any = access.onBehalf ? await TeachingAssignment.findOne({ classArmId: armId, subjectId, kind: 'subject_teacher' }).lean() : null;
  const rows: any[] = [];
  for (const [studentId, list] of byStudent) {
    const doc: any = (await Score.findOne({ termId: ctx.term._id, subjectId, studentId })) ?? new Score({ termId: ctx.term._id, subjectId, studentId, classArmId: armId, components: {}, absent: [], source: 'entered' });
    for (const cell of list) {
      if (cell.exempt !== undefined) doc.exempt = cell.exempt;
      if (cell.component) {
        const absent = new Set<string>(doc.absent ?? []);
        if (cell.absent === true) {
          absent.add(cell.component);
          if (doc.components) doc.components[cell.component] = undefined;
        } else if (cell.score === null) {
          absent.delete(cell.component);
          if (doc.components) delete doc.components[cell.component];
        } else if (typeof cell.score === 'number') {
          absent.delete(cell.component);
          doc.components = { ...(doc.components ?? {}), [cell.component]: round1(cell.score) };
        } else if (cell.absent === false) absent.delete(cell.component);
        doc.absent = [...absent];
      }
    }
    doc.components = Object.fromEntries(Object.entries(doc.components ?? {}).filter(([, v]) => v !== undefined && v !== null));
    doc.markModified('components');
    doc.classArmId = armId;
    doc.enteredBy = c.userId;
    if (assignment) doc.onBehalfOf = assignment.staffId; // typed by an admin on behalf of the subject teacher, who still submits the sheet
    await doc.save();
    rows.push({ studentId, ...rowOf(doc, ctx.components, ctx.scale) });
  }
  if (edited) await audit({ action: 'scores.edit_after_return', entityType: 'scoreSheet', entityId: sheet._id, after: { cells: cells.length } });
  if (access.onBehalf) await audit({ action: 'scores.enter_on_behalf', entityType: 'scoreSheet', entityId: sheet._id, after: { cells: cells.length } });
  return { saved: cells.length, rows };
}

/** Empty cells that are not flagged absent or exempt. */
export function missingCells(roster: any[], scores: any[], components: Component[]) {
  const byStudent = new Map<string, any>(scores.map((s) => [String(s.studentId), s]));
  const out: Array<{ studentId: string; name: string; missing: string[] }> = [];
  for (const s of roster) {
    const cell = byStudent.get(String(s._id));
    if (cell?.exempt) continue;
    const absent = new Set(cell?.absent ?? []);
    const missing = components.filter((k) => !absent.has(k.key) && (cell?.components?.[k.key] === undefined || cell?.components?.[k.key] === null)).map((k) => k.key);
    if (missing.length) out.push({ studentId: String(s._id), name: fullName(s), missing });
  }
  return out;
}

/** Submit the sheet. It fails if any cell is empty and unflagged. It becomes read-only for the teacher. */
export async function submitSheet(armId: string, subjectId: string, termId?: string) {
  const c = me();
  const ctx = await sheetContext(armId, subjectId, termId);
  await sheetAccess(armId, subjectId, 'enter');
  await assertTermOpen(ctx.term._id);
  await assertResultEditable(ctx.term._id, armId);
  const sheet = await getOrCreateSheet(ctx.term._id, armId, subjectId);
  assertTransition('scoreSheet', sheet.status, 'submitted', 'This score sheet');
  const scores: any[] = await Score.find({ termId: ctx.term._id, subjectId, studentId: { $in: ctx.roster.map((s) => s._id) } }).lean();
  const missing = missingCells(ctx.roster, scores, ctx.components);
  if (missing.length) {
    throw new AppError('incomplete_scores', `${missing.length} student${missing.length === 1 ? ' has' : 's have'} empty cells. Enter a score, or mark the cell absent or the subject exempt.`, { details: { missing: missing.map((m) => ({ ...m, columns: m.missing })) } });
  }
  sheet.status = 'submitted';
  sheet.submittedBy = c.userId;
  sheet.submittedAt = new Date();
  sheet.returnNote = undefined;
  await sheet.save();
  await audit({ action: 'scores.sheet.submit', entityType: 'scoreSheet', entityId: sheet._id, after: { classArmId: armId, subjectId, termId: String(ctx.term._id) } });
  return sheet;
}

/** The class teacher or the principal returns a sheet to its teacher with a note. */
export async function returnSheet(armId: string, subjectId: string, termId: string | undefined, note: string) {
  const c = me();
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id);
  await need(ClassArm.findById(armId).lean(), 'Class');
  if (!(c.roles.includes('principal') || c.roles.includes('owner'))) await assertClassTeacherOf(armId, false);
  const cr: any = await ClassResult.findOne({ termId: term._id, classArmId: armId });
  if (cr && ['awaiting_approval', 'approved', 'published'].includes(cr.status)) throw new AppError('result_locked', 'The class result is already with the principal or published. Return it first.');
  const sheet = await getOrCreateSheet(term._id, armId, subjectId);
  assertTransition('scoreSheet', sheet.status, 'returned', 'This score sheet');
  sheet.status = 'returned';
  sheet.returnNote = note;
  sheet.returnedBy = c.userId;
  await sheet.save();
  if (cr && cr.status === 'compiled') {
    cr.status = 'open';
    await cr.save();
  }
  await audit({ action: 'scores.sheet.return', entityType: 'scoreSheet', entityId: sheet._id, reason: note });
  const subject: any = await Subject.findById(subjectId).select('name').lean();
  const names = await classNames([armId]);
  const teacher: any = sheet.staffId ? await Staff.findById(sheet.staffId).select('userId').lean() : null;
  if (teacher?.userId) await notify({ event: 'sheet_returned', to: [{ userId: String(teacher.userId), kind: 'staff' }], vars: { subject: subject?.name ?? '', class: names.get(armId)?.name ?? '', note } });
  return sheet;
}

/** Status of every subject sheet for a class arm and term. */
export async function sheetsStatus(armId: string, termId?: string) {
  const term: any = await resolveTerm(termId);
  const c = me();
  const t = await myTeaching();
  const ac = await armContext(armId);
  const classSubjects: any[] = await ClassSubject.find({ classLevelId: ac.level._id }).lean();
  const subjects = new Map<string, any>((await Subject.find({ _id: { $in: classSubjects.map((x) => x.subjectId) } }).lean()).map((s: any) => [String(s._id), s]));
  const assignments: any[] = await TeachingAssignment.find({ classArmId: armId, kind: 'subject_teacher' }).lean();
  const staff = new Map<string, any>((await Staff.find({ _id: { $in: assignments.map((a) => a.staffId) } }).select('firstName lastName').lean()).map((s: any) => [String(s._id), s]));
  const sheets: any[] = await ScoreSheet.find({ termId: term._id, classArmId: armId }).lean();
  const seeAll = hasFullReach() || c.roles.includes('principal') || t.classTeacherArms.has(armId);
  const out: any[] = [];
  for (const cs of classSubjects) {
    const sid = String(cs.subjectId);
    if (!seeAll && !t.subjectsByArm.get(armId)?.has(sid)) continue;
    const roster = await subjectRoster(armId, sid, String(term._id), term.sessionId);
    if (!roster.length) continue;
    const sheet = sheets.find((x) => String(x.subjectId) === sid);
    const scores: any[] = await Score.find({ termId: term._id, subjectId: sid, studentId: { $in: roster.map((s) => s._id) } }).lean();
    const missing = missingCells(roster, scores, [...ac.structure.components]);
    const a = assignments.find((x) => String(x.subjectId) === sid);
    out.push({ subjectId: sid, subject: subjects.get(sid)?.name, teacher: a ? fullName(staff.get(String(a.staffId))) : null, teacherAssigned: !!a, status: sheet?.status ?? 'draft', students: roster.length, incomplete: missing.length, submittedAt: sheet?.submittedAt, returnNote: sheet?.returnNote });
  }
  return { termId: String(term._id), classArmId: armId, sheets: out.sort((a, b) => String(a.subject).localeCompare(String(b.subject))), outstanding: out.filter((s) => s.status !== 'submitted').length };
}

// ------------------------------------------------------------------ spreadsheet upload

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/** Fill the sheet from the spreadsheet template: Admission number, then one column per component. ABS marks absent, EXEMPT marks the subject exempt. */
export async function uploadSheet(armId: string, subjectId: string, termId: string | undefined, fileRef: string) {
  const ctx = await sheetContext(armId, subjectId, termId);
  await sheetAccess(armId, subjectId, 'enter');
  await confirmFile(fileRef, 'import_file');
  const buf = await files.getBuffer(fileRef);
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileRef)) await wb.csv.read(Readable.from(buf));
  else await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  if (!ws) throw validation('The file has no sheet.', { fileRef: 'Empty file.' });
  const header = (ws.getRow(1).values as any[]).slice(1).map(norm);
  const admCol = header.findIndex((h) => h === 'admissionnumber' || h === 'admissionno' || h === 'admno');
  if (admCol < 0) throw validation('The first row needs an "Admission number" column.', { fileRef: 'Missing the Admission number column.' });
  const colOf = new Map<string, number>();
  for (const k of ctx.components) {
    const idx = header.findIndex((h) => h === norm(k.key) || h === norm(k.name));
    if (idx >= 0) colOf.set(k.key, idx);
  }
  if (!colOf.size) throw validation('None of the columns match this sheet. Download the template for this class and subject.', { fileRef: 'No matching columns.' });
  const byAdm = new Map(ctx.roster.map((s) => [String(s.admissionNumber).toUpperCase(), s]));
  const cells: CellInput[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const vals = (row.values as any[]).slice(1);
    const adm = String(vals[admCol] ?? '').trim().toUpperCase();
    if (!adm) return;
    const s = byAdm.get(adm);
    if (!s) return errors.push({ row: n, message: `${adm} is not on this class list.` });
    for (const [key, idx] of colOf) {
      const raw = vals[idx];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const text = String(raw).trim().toUpperCase();
      if (text === 'ABS') cells.push({ studentId: String(s._id), component: key, absent: true });
      else if (text === 'EXEMPT') cells.push({ studentId: String(s._id), exempt: true });
      else {
        const num = Number(text);
        if (!Number.isFinite(num)) errors.push({ row: n, message: `${key}: "${raw}" is not a number.` });
        else cells.push({ studentId: String(s._id), component: key, score: num });
      }
    }
  });
  if (errors.length) throw new AppError('validation_failed', `${errors.length} row${errors.length === 1 ? ' needs' : 's need'} attention. Nothing was saved.`, { details: { errors } });
  const out = await saveCells(armId, subjectId, termId, cells);
  return { ...out, rows: out.rows.length };
}

export { getCtx, Term, can };
