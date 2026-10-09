import ExcelJS from 'exceljs';
import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { AppError, forbidden, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { can, me } from '../core/http';
import { computeSubject, computeTermResults, subjectPositions, subjectStats, type Component } from '../calc/results';
import { suggestComment } from '../calc/comments';
import { randomCode } from '../lib/crypto';
import { schoolLink } from '../lib/links';
import { formatKobo } from '../lib/money';
import { saveGenerated, files } from '../integrations/storage';
import { enqueue, registerJob } from '../jobs/queue';
import {
  ClassArm, ClassLevel, ClassResult, ClassSubject, CommentBank, Enrolment, FeeItem, FeeStructure, Guardian, Invoice, LevelGroup, PromotionDecision, PromotionList, School, Score, ScoreSheet, Staff, Student, StudentGuardian, Subject, TeachingAssignment, Term, AcademicSession, TermResult, Trait
} from '../models';
import { armContext, armStudents, assertTermOpen, subjectRoster } from './academics';
import { studentTermTotals, termTotals } from './attendance';
import { assertResultEditable, missingCells } from './scores';
import { fullName, loadSchool, need, staffRecipients } from './common';
import { notify } from './notify';
import { assertCanSeeStudent, assertClassTeacherOf, currentSession, hasFullReach, myChildIds, myTeaching, resolveTerm, studentAccess } from './reach';
import { classNames } from './students';
import { reportCardPdf, reportCardsPdf, broadsheetPdf, type CardSubject, type ReportCardData } from '../templates/reportCard';
import type { Brand } from '../templates/pdf';
import { photoUrl } from './common';

/** Class results: compile, comments, the approval chain, publishing, report cards (RES-03 to RES-14, FEE-14, flows F13, F17). */

const brandOf = (school: any): Brand => ({ name: school.name, motto: school.motto, logoRef: school.branding?.logo, stampRef: school.branding?.stamp, signatureRef: school.branding?.signature, primary: school.branding?.primary, secondary: school.branding?.secondary, address: [school.address?.street, school.address?.town, school.address?.state].filter(Boolean).join(', '), phone: school.phone, email: school.email });

async function classResultDoc(termId: unknown, armId: string) {
  await ClassResult.updateOne({ termId, classArmId: armId }, { $setOnInsert: { termId, classArmId: armId, status: 'open' } }, { upsert: true });
  return ClassResult.findOne({ termId, classArmId: armId }) as Promise<any>;
}

// ------------------------------------------------------------------ computing a class

interface SubjectBlock {
  subjectId: string;
  name: string;
  roster: any[];
  scores: Map<string, any>;
  results: Map<string, ReturnType<typeof computeSubject>>;
}

async function loadArm(armId: string, term: any, ac: any) {
  const comps: Component[] = [...ac.structure.components].sort((a: any, b: any) => a.order - b.order);
  const classSubjects: any[] = await ClassSubject.find({ classLevelId: ac.level._id }).lean();
  const subjects = new Map<string, any>((await Subject.find({ _id: { $in: classSubjects.map((x) => x.subjectId) } }).lean()).map((s: any) => [String(s._id), s]));
  const blocks: SubjectBlock[] = [];
  for (const cs of classSubjects) {
    const sid = String(cs.subjectId);
    const roster = await subjectRoster(armId, sid, String(term._id), term.sessionId);
    if (!roster.length) continue;
    const scoreDocs: any[] = await Score.find({ termId: term._id, subjectId: sid, studentId: { $in: roster.map((s) => s._id) } }).lean();
    const scores = new Map<string, any>(scoreDocs.map((s) => [String(s.studentId), s]));
    const results = new Map<string, ReturnType<typeof computeSubject>>();
    for (const s of roster) {
      const cell = scores.get(String(s._id));
      results.set(String(s._id), computeSubject({ components: cell?.components ?? {}, absent: cell?.absent ?? [], exempt: !!cell?.exempt }, comps, ac.scale));
    }
    blocks.push({ subjectId: sid, name: subjects.get(sid)?.name ?? 'Subject', roster, scores, results });
  }
  blocks.sort((a, b) => a.name.localeCompare(b.name));
  return { comps, blocks };
}

/** Totals per student across the arm's subjects, for ranking. Used for the arm itself and, with positionScope "level", sibling arms. */
async function rankInputs(armId: string, term: any, ac: any) {
  const { blocks } = await loadArm(armId, term, ac);
  const perStudent = new Map<string, number[]>();
  const subjectTotals = new Map<string, Array<{ studentId: string; total: number }>>();
  for (const b of blocks) {
    const list: Array<{ studentId: string; total: number }> = [];
    for (const s of b.roster) {
      const r = b.results.get(String(s._id))!;
      if (r.exempt || r.total === null) continue;
      list.push({ studentId: String(s._id), total: r.total });
      perStudent.set(String(s._id), [...(perStudent.get(String(s._id)) ?? []), r.total]);
    }
    subjectTotals.set(b.subjectId, list);
  }
  return { perStudent, subjectTotals };
}

export async function compileClassResult(armId: string, termId?: string) {
  const c = me();
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id);
  const ac = await armContext(armId);
  const cr = await classResultDoc(term._id, armId);
  if (['awaiting_approval', 'approved', 'published'].includes(cr.status)) throw new AppError('result_locked', 'The class result is with the principal or published. Return or reopen it before compiling again.');
  if (!(c.roles.includes('principal'))) await assertClassTeacherOf(armId, false);

  const showPositions = !!ac.group.showPositions;
  const students = await armStudents(armId, term.sessionId);
  const attendance = await termTotals(String(term._id), students.map((s) => String(s._id)));
  const school: any = await loadSchool();

  // ---- nursery: ratings and remarks, no totals or positions
  if (ac.group.reportLayout === 'ratings') {
    for (const s of students) {
      const t = attendance.get(String(s._id)) ?? { opened: 0, present: 0, absent: 0 };
      await TermResult.updateOne({ termId: term._id, studentId: s._id }, { $set: { classArmId: armId, attendance: { opened: t.opened, present: t.present, absent: t.absent }, source: 'entered' }, $setOnInsert: { termId: term._id, studentId: s._id } }, { upsert: true });
    }
  } else {
    const { comps, blocks } = await loadArm(armId, term, ac);

    // Sheets must all be in, and every compulsory score present, absent or exempt.
    const outstanding = blocks.filter(() => true).map((b) => b.subjectId);
    const sheets: any[] = await ScoreSheet.find({ termId: term._id, classArmId: armId }).lean();
    const notIn = outstanding.filter((sid) => sheets.find((x) => String(x.subjectId) === sid)?.status !== 'submitted');
    const missing: Array<{ studentId: string; name: string; subject: string; columns: string[] }> = [];
    for (const b of blocks) {
      const gaps = missingCells(b.roster, [...b.scores.values()], comps);
      for (const g of gaps) missing.push({ ...g, subject: b.name, columns: g.missing });
    }
    if (notIn.length || missing.length) {
      const names = new Map(blocks.map((b) => [b.subjectId, b.name]));
      throw new AppError('incomplete_scores', notIn.length ? `${notIn.length} score sheet${notIn.length === 1 ? ' is' : 's are'} not submitted yet.` : `${missing.length} student${missing.length === 1 ? ' has' : 's have'} missing scores.`, {
        details: { outstandingSheets: notIn.map((sid) => ({ subjectId: sid, subject: names.get(sid) })), missing }
      });
    }

    // Positions across the arm, or across every arm of the level when the school ranks by level.
    const rank = await rankInputs(armId, term, ac);
    let scopeSubjectTotals = rank.subjectTotals;
    let scopePerStudent = rank.perStudent;
    if (school.settings?.positionScope === 'level') {
      scopeSubjectTotals = new Map(rank.subjectTotals);
      scopePerStudent = new Map(rank.perStudent);
      const siblings: any[] = await ClassArm.find({ classLevelId: ac.level._id, _id: { $ne: armId }, active: true }).lean();
      for (const sib of siblings) {
        const sr = await rankInputs(String(sib._id), term, ac);
        for (const [sid, list] of sr.subjectTotals) scopeSubjectTotals.set(sid, [...(scopeSubjectTotals.get(sid) ?? []), ...list]);
        for (const [stu, totals] of sr.perStudent) scopePerStudent.set(stu, totals);
      }
    }

    const termRows = computeTermResults([...scopePerStudent.entries()].map(([studentId, totals]) => ({ studentId, totals })), showPositions);
    const termByStudent = new Map(termRows.map((r) => [r.studentId, r]));

    for (const b of blocks) {
      const all = scopeSubjectTotals.get(b.subjectId) ?? [];
      const stats = subjectStats(all.map((x) => x.total));
      const pos = showPositions ? subjectPositions(all) : new Map<string, number>();
      for (const s of b.roster) {
        const r = b.results.get(String(s._id))!;
        const set: any = r.exempt ? { total: null, grade: null, remark: null, subjectPosition: null, classAverage: null, highest: null, lowest: null } : { total: r.total, grade: r.grade, remark: r.remark, subjectPosition: pos.get(String(s._id)) ?? null, classAverage: stats?.average ?? null, highest: stats?.highest ?? null, lowest: stats?.lowest ?? null };
        await Score.updateOne({ termId: term._id, subjectId: b.subjectId, studentId: s._id }, { $set: { ...set, classArmId: armId }, $setOnInsert: { source: 'entered', components: {} } }, { upsert: true });
      }
    }
    for (const s of students) {
      const tr = termByStudent.get(String(s._id));
      const t = attendance.get(String(s._id)) ?? { opened: 0, present: 0, absent: 0 };
      await TermResult.updateOne(
        { termId: term._id, studentId: s._id },
        { $set: { classArmId: armId, subjectsCount: tr?.subjectsCount ?? 0, total: tr?.total ?? null, average: tr?.average ?? null, position: tr?.position ?? null, classSize: tr?.classSize ?? 0, attendance: { opened: t.opened, present: t.present, absent: t.absent }, source: 'entered' }, $setOnInsert: { termId: term._id, studentId: s._id } },
        { upsert: true }
      );
    }
  }

  assertTransition('classResult', cr.status, 'compiled', 'This class result');
  cr.status = 'compiled';
  cr.compiledBy = c.userId;
  cr.compiledAt = new Date();
  cr.rejectNote = undefined;
  await cr.save();
  await audit({ action: 'results.compile', entityType: 'classResult', entityId: cr._id, after: { classArmId: armId, students: students.length } });
  return { status: cr.status, students: students.length };
}

registerJob('compile-class-result', async ({ payload, userId }) => {
  // The job runs with the school scope but not the user's permissions: they were checked when it was queued.
  const ctx = getCtx()!;
  ctx.userId = userId;
  ctx.roles = payload.roles ?? [];
  ctx.permissions = new Set(payload.permissions ?? []);
  ctx.staffId = payload.staffId;
  return compileClassResult(payload.classArmId, payload.termId);
});

export async function startCompile(armId: string, termId?: string) {
  const c = me();
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id);
  if (!c.roles.includes('principal')) await assertClassTeacherOf(armId, false);
  // Fail fast with the list of what is missing, so the answer comes back at once rather than from the job.
  await precheckCompile(armId, term);
  return enqueue('compile-class-result', { classArmId: armId, termId: String(term._id), roles: c.roles, permissions: [...c.permissions], staffId: c.staffId }, { schoolId: c.schoolId, userId: c.userId });
}

async function precheckCompile(armId: string, term: any) {
  const ac = await armContext(armId);
  if (ac.group.reportLayout === 'ratings') return;
  const { comps, blocks } = await loadArm(armId, term, ac);
  const sheets: any[] = await ScoreSheet.find({ termId: term._id, classArmId: armId }).lean();
  const notIn = blocks.filter((b) => sheets.find((x) => String(x.subjectId) === b.subjectId)?.status !== 'submitted');
  const missing: any[] = [];
  for (const b of blocks) for (const g of missingCells(b.roster, [...b.scores.values()], comps)) missing.push({ ...g, subject: b.name, columns: g.missing });
  if (notIn.length || missing.length) {
    throw new AppError('incomplete_scores', notIn.length ? `${notIn.length} score sheet${notIn.length === 1 ? ' is' : 's are'} not submitted yet.` : `${missing.length} student${missing.length === 1 ? ' has' : 's have'} missing scores.`, { details: { outstandingSheets: notIn.map((b) => ({ subjectId: b.subjectId, subject: b.name })), missing } });
  }
}

// ------------------------------------------------------------------ reading a class result

export async function classResultView(armId: string, termId?: string) {
  const c = me();
  const term: any = await resolveTerm(termId);
  const t = await myTeaching();
  if (!(hasFullReach() || c.roles.includes('principal') || t.classTeacherArms.has(armId))) throw notFound('Class');
  const ac = await armContext(armId);
  const cr = await classResultDoc(term._id, armId);
  const students = await armStudents(armId, term.sessionId);
  const trs: any[] = await TermResult.find({ termId: term._id, studentId: { $in: students.map((s) => s._id) } }).lean();
  const byStudent = new Map<string, any>(trs.map((r) => [String(r.studentId), r]));
  const sheets = await ScoreSheet.find({ termId: term._id, classArmId: armId }).lean();
  const traits: any[] = await Trait.find({ levelGroupId: ac.group._id, active: true }).sort({ order: 1, name: 1 }).lean();
  return {
    termId: String(term._id),
    classArmId: armId,
    status: cr.status,
    layout: ac.group.reportLayout,
    showPositions: ac.group.showPositions,
    rejectNote: cr.rejectNote,
    compiledAt: cr.compiledAt,
    publishedAt: cr.publishedAt,
    revision: cr.revision,
    sameHandsNotice: cr.status === 'awaiting_approval' || cr.status === 'approved' || cr.status === 'published' ? !!cr.enteredAndApprovedBySame : false,
    sheetsSubmitted: sheets.filter((s: any) => s.status === 'submitted').length,
    traits: traits.map((x) => ({ id: String(x._id), name: x.name, category: x.category, scale: x.scale })),
    students: students.map((s) => {
      const r = byStudent.get(String(s._id));
      return { studentId: String(s._id), name: fullName(s), admissionNumber: s.admissionNumber, photoUrl: photoUrl(s.photo), subjectsCount: r?.subjectsCount ?? null, total: r?.total ?? null, average: r?.average ?? null, position: r?.position ?? null, classSize: r?.classSize, attendance: r?.attendance, ratings: r?.ratings ?? [], teacherComment: r?.teacherComment, principalComment: r?.principalComment, published: !!r?.published, revision: r?.revision ?? 0 };
    })
  };
}

// ------------------------------------------------------------------ ratings and comments

export async function saveRatings(armId: string, termId: string | undefined, items: Array<{ studentId: string; ratings: Array<{ traitId: string; value: number; remark?: string }> }>) {
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id);
  await assertClassTeacherOf(armId, false);
  await assertResultEditable(term._id, armId);
  const ac = await armContext(armId);
  const traits = new Map<string, any>((await Trait.find({ levelGroupId: ac.group._id }).lean()).map((t: any) => [String(t._id), t]));
  const roster = new Set((await armStudents(armId, term.sessionId)).map((s) => String(s._id)));
  for (const it of items) {
    if (!roster.has(it.studentId)) throw validation('A student is not in this class.', { items: 'Not in this class.' });
    for (const r of it.ratings) {
      const t = traits.get(r.traitId);
      if (!t) throw validation('That rating is not for this class level.', { items: 'Unknown rating.' });
      if (!t.scale.some((x: any) => x.value === r.value)) throw validation(`${t.name}: choose one of the values on the scale.`, { items: 'Not on the scale.' });
    }
    const formatted = it.ratings.map((r) => ({ traitId: r.traitId, name: traits.get(r.traitId).name, value: r.value, remark: r.remark }));
    await TermResult.updateOne({ termId: term._id, studentId: it.studentId }, { $set: { ratings: formatted, classArmId: armId }, $setOnInsert: { termId: term._id, studentId: it.studentId } }, { upsert: true });
  }
  return { saved: items.length };
}

export async function saveComments(armId: string, termId: string | undefined, items: Array<{ studentId: string; teacher?: string; principal?: string }>) {
  const c = me();
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id);
  const isPrincipal = c.roles.includes('principal') || c.roles.includes('owner');
  const t = await myTeaching();
  const isClassTeacher = t.classTeacherArms.has(armId);
  if (!isPrincipal && !isClassTeacher) throw forbidden();
  const cr: any = await classResultDoc(term._id, armId);
  // The principal writes comments while reviewing; the class teacher before submitting.
  if (['approved', 'published'].includes(cr.status)) throw new AppError('result_locked', 'The result is approved or published. Reopen it to change comments.');
  if (!isPrincipal && cr.status === 'awaiting_approval') throw new AppError('result_locked', 'The result is with the principal.');
  const roster = new Set((await armStudents(armId, term.sessionId)).map((s) => String(s._id)));
  for (const it of items) {
    if (!roster.has(it.studentId)) throw validation('A student is not in this class.', { items: 'Not in this class.' });
    const set: any = {};
    if (it.teacher !== undefined) {
      if (!isClassTeacher) throw forbidden('Only the class teacher writes the class teacher’s comment.');
      set.teacherComment = it.teacher;
    }
    if (it.principal !== undefined) {
      if (!isPrincipal) throw forbidden('Only the principal writes the principal’s comment.');
      set.principalComment = it.principal;
    }
    await TermResult.updateOne({ termId: term._id, studentId: it.studentId }, { $set: { ...set, classArmId: armId }, $setOnInsert: { termId: term._id, studentId: it.studentId } }, { upsert: true });
  }
  return { saved: items.length };
}

/** A comment bank suggests comments from the student's average band using fixed rules. Staff can edit before saving. */
export async function commentSuggestions(armId: string, termId?: string) {
  const term: any = await resolveTerm(termId);
  const bank: any[] = await CommentBank.find({}).lean();
  const students = await armStudents(armId, term.sessionId);
  const trs: any[] = await TermResult.find({ termId: term._id, studentId: { $in: students.map((s) => s._id) } }).lean();
  const byStudent = new Map<string, any>(trs.map((r) => [String(r.studentId), r]));
  return students.map((s, i) => {
    const avg = byStudent.get(String(s._id))?.average ?? null;
    return { studentId: String(s._id), name: fullName(s), average: avg, teacher: suggestComment(bank, 'class_teacher', avg, i), principal: suggestComment(bank, 'principal', avg, i) };
  });
}

// ------------------------------------------------------------------ the approval chain

export async function submitClassResult(armId: string, termId?: string) {
  const c = me();
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id);
  await assertClassTeacherOf(armId, false);
  const cr = await classResultDoc(term._id, armId);
  assertTransition('classResult', cr.status, 'awaiting_approval', 'This class result');
  cr.status = 'awaiting_approval';
  cr.submittedBy = c.userId;
  cr.submittedAt = new Date();
  await cr.save();
  await audit({ action: 'results.submit', entityType: 'classResult', entityId: cr._id });
  const names = await classNames([armId]);
  await notify({ event: 'result_awaiting_approval', to: (await staffRecipients(c.schoolId!, ['principal', 'owner'])).map((r) => ({ ...r, kind: 'staff' as const })), vars: { class: names.get(armId)?.name ?? '' } });
  return cr;
}

/** Where one person entered and approved the same result, the screen says so and both acts are audited. */
export async function approveClassResult(armId: string, termId?: string) {
  const c = me();
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id);
  const cr = await classResultDoc(term._id, armId);
  assertTransition('classResult', cr.status, 'approved', 'This class result');
  const enteredByMe = !!(await Score.exists({ termId: term._id, classArmId: armId, enteredBy: c.userId })) || String(cr.compiledBy) === c.userId || String(cr.submittedBy) === c.userId;
  cr.status = 'approved';
  cr.approvedBy = c.userId;
  cr.approvedAt = new Date();
  cr.enteredAndApprovedBySame = enteredByMe;
  await cr.save();
  await audit({ action: 'results.approve', entityType: 'classResult', entityId: cr._id, after: { sameHands: enteredByMe } });
  if (enteredByMe) await audit({ action: 'results.approve.same_person', entityType: 'classResult', entityId: cr._id, reason: 'The person who entered or compiled the scores also approved them.' });
  if (resultHooks.onApproved) await resultHooks.onApproved(term._id, armId);
  return cr;
}

export async function rejectClassResult(armId: string, termId: string | undefined, note: string) {
  const term: any = await resolveTerm(termId);
  const cr = await classResultDoc(term._id, armId);
  assertTransition('classResult', cr.status, 'open', 'This class result');
  cr.status = 'open';
  cr.rejectNote = note;
  await cr.save();
  await audit({ action: 'results.reject', entityType: 'classResult', entityId: cr._id, reason: note });
  const teacher: any = await TeachingAssignment.findOne({ classArmId: armId, kind: 'class_teacher' }).lean();
  const staff: any = teacher ? await Staff.findById(teacher.staffId).select('userId').lean() : null;
  if (staff?.userId) {
    const names = await classNames([armId]);
    await notify({ event: 'sheet_returned', to: [{ userId: String(staff.userId), kind: 'staff' }], vars: { subject: 'Class result', class: names.get(armId)?.name ?? '', note } });
  }
  return cr;
}

/** Publish: report cards are generated, locked, and parents and students are notified. */
export async function publishClassResult(armId: string, termId?: string) {
  const c = me();
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id);
  const cr = await classResultDoc(term._id, armId);
  const revised = cr.status === 'reopened' ? false : false;
  void revised;
  assertTransition('classResult', cr.status, 'published', 'This class result');
  const wasRevision = (cr.reopenLog?.length ?? 0) > 0;
  const students = await armStudents(armId, term.sessionId);
  for (const s of students) {
    const tr: any = await TermResult.findOne({ termId: term._id, studentId: s._id });
    if (!tr) continue;
    tr.published = true;
    if (!tr.verificationCode) tr.verificationCode = randomCode(10);
    if (wasRevision) {
      tr.revision = (tr.revision ?? 0) + 1;
      tr.revisedAt = new Date();
    }
    await tr.save();
  }
  cr.status = 'published';
  cr.publishedBy = c.userId;
  cr.publishedAt = new Date();
  if (wasRevision) cr.revision = (cr.revision ?? 0) + 1;
  await cr.save();
  await audit({ action: 'results.publish', entityType: 'classResult', entityId: cr._id, after: { classArmId: armId, revision: cr.revision } });
  return enqueue('generate-report-cards', { termId: String(term._id), classArmId: armId, revised: wasRevision }, { schoolId: c.schoolId, userId: c.userId });
}

/**
 * Reopen a published result for the class or named students, with a reason. Sheets go back to their teachers for correction,
 * the class teacher recompiles, the principal approves and republishes, and the card is marked as a revised copy.
 */
export async function reopenClassResult(armId: string, termId: string | undefined, reason: string, studentIds?: string[]) {
  const c = me();
  const term: any = await resolveTerm(termId);
  await assertTermOpen(term._id); // a closed term must be reopened first
  const cr = await classResultDoc(term._id, armId);
  assertTransition('classResult', cr.status, 'reopened', 'This class result');
  cr.status = 'reopened';
  cr.reopenLog.push({ at: new Date(), by: c.userId, reason, studentIds: studentIds ?? [] });
  await cr.save();
  await ScoreSheet.updateMany({ termId: term._id, classArmId: armId, status: 'submitted' }, { status: 'returned', returnNote: `Result reopened: ${reason}` });
  await audit({ action: 'results.reopen', entityType: 'classResult', entityId: cr._id, reason, after: { studentIds: studentIds ?? 'all' } });
  return cr;
}

// ------------------------------------------------------------------ report cards

async function nextTermInfo(term: any, levelId: unknown) {
  const next: any = (await Term.findOne({ sessionId: term.sessionId, number: term.number + 1 }).lean()) ?? null;
  let feesKobo = 0;
  if (next) {
    const st: any = await FeeStructure.findOne({ termId: next._id, classLevelId: levelId }).lean();
    if (st) {
      const items = new Map<string, any>((await FeeItem.find({ _id: { $in: st.lines.map((l: any) => l.feeItemId) } }).lean()).map((i: any) => [String(i._id), i]));
      feesKobo = st.lines.filter((l: any) => !items.get(String(l.feeItemId))?.optional).reduce((a: number, l: any) => a + l.amountKobo, 0);
    }
  }
  return { nextTermBegins: term.nextTermBegins as string | undefined, feesKobo };
}

/** The complete data for one student's report card in one term. */
export async function buildCardData(school: any, term: any, tr: any, ctx?: { ac?: any; session?: any }): Promise<ReportCardData> {
  const student: any = await Student.findById(tr.studentId).lean();
  const ac = ctx?.ac ?? (await armContext(tr.classArmId));
  const session: any = ctx?.session ?? (await AcademicSession.findById(term.sessionId).lean());
  const comps: Component[] = ac.structure ? [...ac.structure.components].sort((a: any, b: any) => a.order - b.order) : [];
  const scores: any[] = await Score.find({ termId: term._id, studentId: tr.studentId }).lean();
  const subjects = new Map<string, any>((await Subject.find({ _id: { $in: scores.map((s) => s.subjectId) } }).lean()).map((s: any) => [String(s._id), s]));
  const subs: CardSubject[] = scores
    .map((s) => ({
      name: subjects.get(String(s.subjectId))?.name ?? 'Subject',
      components: Object.fromEntries(comps.map((k) => [k.key, (s.absent ?? []).includes(k.key) ? 'ABS' : s.components?.[k.key] ?? null])) as any,
      exempt: !!s.exempt,
      total: s.total ?? null,
      grade: s.grade ?? null,
      remark: s.remark ?? null,
      position: s.subjectPosition ?? null,
      classAverage: s.classAverage ?? null,
      highest: s.highest ?? null,
      lowest: s.lowest ?? null
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const traits = new Map<string, any>((await Trait.find({ levelGroupId: ac.group._id }).lean()).map((t: any) => [String(t._id), t]));
  const ratings = (tr.ratings ?? []).map((r: any) => ({ name: r.name, value: r.value, label: traits.get(String(r.traitId))?.scale?.find((x: any) => x.value === r.value)?.label, remark: r.remark, category: traits.get(String(r.traitId))?.category }));
  const next = await nextTermInfo(term, ac.level._id);

  // The promotion outcome prints on the third-term report card.
  let promotion: string | undefined;
  if (term.number === 3) {
    const d: any = await PromotionDecision.findOne({ sessionId: term.sessionId, studentId: tr.studentId }).lean();
    const list: any = d ? await PromotionList.findOne({ sessionId: term.sessionId, classArmId: d.classArmId }).lean() : null;
    if (d && list && ['approved', 'applied'].includes(list.status)) promotion = outcomeText(d.final?.outcome ?? d.proposed?.outcome);
  }
  const photo = student.photo && /\.(png|jpe?g)$/i.test(student.photo) ? await files.getBuffer(student.photo).catch(() => undefined) : undefined;
  return {
    student: { name: fullName(student), admissionNumber: student.admissionNumber, gender: student.gender, dob: student.dob, photo },
    className: (await classNames([String(tr.classArmId)])).get(String(tr.classArmId))?.name ?? '',
    sessionName: session?.name ?? '',
    termNumber: term.number,
    layout: ac.group.reportLayout,
    showPositions: !!ac.group.showPositions,
    components: comps.map((k) => ({ key: k.key, name: k.name ?? k.key, max: k.max })),
    subjects: subs,
    summary: tr.subjectsCount ? { subjectsCount: tr.subjectsCount, total: tr.total, average: tr.average, position: tr.position ?? null, classSize: tr.classSize } : undefined,
    attendance: tr.attendance,
    ratings,
    teacherComment: tr.teacherComment,
    principalComment: tr.principalComment,
    nextTermBegins: next.nextTermBegins,
    nextTermFeesKobo: next.feesKobo || undefined,
    promotion,
    verificationCode: tr.verificationCode ?? '',
    verifyUrl: schoolLink(school.slug, `/verify/${tr.verificationCode ?? ''}`),
    revisedAt: tr.revision > 0 ? tr.revisedAt : undefined,
    passMark: ac.scale?.passMark
  };
}

/** Set by the promotion service so approving a third-term result starts the annual result without a circular import. */
export const resultHooks: { onApproved?: (termId: unknown, armId: string) => Promise<unknown> } = {};

export const outcomeText = (o?: string) => (({ promoted: 'Promoted to the next class', promoted_on_trial: 'Promoted on trial', repeat: 'To repeat the class', graduated: 'Graduated', undecided: 'To be decided' }) as Record<string, string>)[o ?? ''];

/**
 * Report cards are produced one student at a time, then all of a class in one PDF so the school can print a whole class in
 * one go. A revised report card is a new file; the earlier file is kept and marked superseded.
 */
registerJob('generate-report-cards', async ({ payload, schoolId, progress }) => {
  const school: any = await School.findById(schoolId).lean();
  const term: any = await Term.findById(payload.termId).lean();
  const ac = await armContext(payload.classArmId);
  const session: any = await AcademicSession.findById(term.sessionId).lean();
  const brand = brandOf(school);
  const filter: any = { termId: term._id, classArmId: payload.classArmId, published: true };
  if (payload.studentIds?.length) filter.studentId = { $in: payload.studentIds };
  const trs: any[] = await TermResult.find(filter).lean();
  const students = new Map<string, any>((await Student.find({ _id: { $in: trs.map((t) => t.studentId) } }).select('firstName lastName').lean()).map((s: any) => [String(s._id), s]));
  trs.sort((a, b) => fullName(students.get(String(a.studentId))).localeCompare(fullName(students.get(String(b.studentId)))));

  const cards: ReportCardData[] = [];
  let n = 0;
  for (const tr of trs) {
    const data = await buildCardData(school, term, tr, { ac, session });
    cards.push(data);
    const buf = await reportCardPdf(brand, { ...data });
    const ref = await saveGenerated(String(schoolId), buf, 'application/pdf', 'pdf');
    const prev = tr.reportCard?.file;
    await TermResult.updateOne({ _id: tr._id }, { $set: { 'reportCard.file': ref, 'reportCard.generatedAt': new Date() }, ...(prev ? { $push: { 'reportCard.superseded': { file: prev, at: new Date() } } } : {}) });
    n += 1;
    if (n % 5 === 0) await progress((n / trs.length) * 90);
  }
  const merged = await reportCardsPdf(brand, cards);
  const mergedRef = await saveGenerated(String(schoolId), merged, 'application/pdf', 'pdf');
  await ClassResult.updateOne({ termId: term._id, classArmId: payload.classArmId }, { cardsFile: mergedRef, cardsGeneratedAt: new Date() });

  // Parents and students are told the result is ready (or revised).
  const school2: any = school;
  for (const tr of trs) {
    const links: any[] = await StudentGuardian.find({ studentId: tr.studentId, access: { $ne: 'none' } }).lean();
    const guardians: any[] = await Guardian.find({ _id: { $in: links.map((l) => l.guardianId) } }).lean();
    const stu: any = await Student.findById(tr.studentId).select('userId firstName lastName').lean();
    await notify({
      schoolId,
      event: payload.revised ? 'result_revised' : 'results_published',
      to: [...guardians.map((g) => ({ userId: g.userId ? String(g.userId) : undefined, phone: g.phone, email: g.email, kind: 'parent' as const })), ...(stu?.userId ? [{ userId: String(stu.userId), kind: 'student' as const }] : [])],
      vars: { child: fullName(stu), term: `term ${term.number}`, link: schoolLink(school2.slug, '/portal') }
    });
  }
  return { cards: cards.length, file: mergedRef };
});

export async function classCardsLink(armId: string, termId?: string) {
  const term: any = await resolveTerm(termId);
  const t = await myTeaching();
  if (!(hasFullReach() || me().roles.includes('principal') || t.classTeacherArms.has(armId))) throw notFound('Class');
  const cr: any = await ClassResult.findOne({ termId: term._id, classArmId: armId }).lean();
  if (!cr?.cardsFile) throw notFound('Report cards');
  return { url: files.link(cr.cardsFile, 300), expiresIn: 300, generatedAt: cr.cardsGeneratedAt, revision: cr.revision };
}

// ------------------------------------------------------------------ broadsheet

export async function broadsheet(armId: string, termId: string | undefined, format: 'json' | 'xlsx' | 'pdf') {
  const c = me();
  const term: any = await resolveTerm(termId);
  const t = await myTeaching();
  if (!(hasFullReach() || c.roles.includes('principal') || t.classTeacherArms.has(armId))) throw notFound('Class');
  const ac = await armContext(armId);
  const school: any = await loadSchool();
  const students = await armStudents(armId, term.sessionId);
  const classSubjects: any[] = await ClassSubject.find({ classLevelId: ac.level._id }).lean();
  const subs = (await Subject.find({ _id: { $in: classSubjects.map((x) => x.subjectId) } }).lean()).sort((a: any, b: any) => a.name.localeCompare(b.name)) as any[];
  const scores: any[] = await Score.find({ termId: term._id, studentId: { $in: students.map((s) => s._id) } }).lean();
  const trs: any[] = await TermResult.find({ termId: term._id, studentId: { $in: students.map((s) => s._id) } }).lean();
  const key = (stu: unknown, sub: unknown) => `${stu}:${sub}`;
  const cell = new Map<string, any>(scores.map((s) => [key(s.studentId, s.subjectId), s]));
  const tmap = new Map<string, any>(trs.map((r) => [String(r.studentId), r]));
  const names = await classNames([armId]);
  const data = {
    className: names.get(armId)?.name ?? '',
    termLabel: `Term ${term.number}`,
    subjects: subs.map((s) => s.name),
    showPositions: !!ac.group.showPositions,
    rows: students.map((s) => {
      const r = tmap.get(String(s._id));
      return { name: fullName(s), admissionNumber: s.admissionNumber, cells: subs.map((sub) => { const x = cell.get(key(s._id, sub._id)); return x && x.total !== null && x.total !== undefined ? { total: x.total as number, grade: x.grade as string } : null; }), subjectsCount: r?.subjectsCount ?? 0, total: r?.total ?? null, average: r?.average ?? null, position: r?.position ?? null };
    })
  };
  if (format === 'json') return { json: data };
  if (format === 'pdf') {
    const buf = await broadsheetPdf(brandOf(school), data);
    const ref = await saveGenerated(String(school._id), buf, 'application/pdf', 'pdf');
    return { url: files.link(ref, 300), name: `broadsheet-${data.className}.pdf` };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Broadsheet');
  ws.addRow(['Admission number', 'Student', ...data.subjects, 'Subjects', 'Total', 'Average', ...(data.showPositions ? ['Position'] : [])]);
  ws.getRow(1).font = { bold: true };
  for (const r of data.rows) ws.addRow([r.admissionNumber, r.name, ...r.cells.map((x) => (x ? x.total : null)), r.subjectsCount, r.total, r.average === null ? null : Math.round(r.average * 100) / 100, ...(data.showPositions ? [r.position] : [])]);
  const ref = await saveGenerated(String(school._id), Buffer.from(await wb.xlsx.writeBuffer()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');
  return { url: files.link(ref, 300), name: `broadsheet-${data.className}.xlsx` };
}

// ------------------------------------------------------------------ what a student, parent or teacher sees

/** Optional school rule: hide a term's result from the parent and student while the fee balance is above a set amount. */
export async function resultBlock(studentId: string, tr?: any) {
  const school: any = await loadSchool();
  const rule = school.settings?.resultBlock;
  if (!rule?.enabled) return { blocked: false as const };
  if (tr?.blockLifted) return { blocked: false as const };
  const invs: any[] = await Invoice.find({ studentId, status: { $in: ['issued', 'part_paid'] } }).select('balanceKobo').lean();
  const balance = invs.reduce((a, i) => a + i.balanceKobo, 0);
  return balance > (rule.thresholdKobo ?? 0) ? { blocked: true as const, balanceKobo: balance, message: `This result is ready. Pay ₦${formatKobo(balance)} to open it.` } : { blocked: false as const };
}

export async function studentResults(studentId: string) {
  const access = await assertCanSeeStudent(studentId);
  const family = access === 'children' || access === 'self';
  const trs: any[] = await TermResult.find({ studentId, ...(family || access === 'own_arm' ? { published: true } : {}) }).lean();
  const terms = new Map<string, any>((await Term.find({ _id: { $in: trs.map((t) => t.termId) } }).lean()).map((t: any) => [String(t._id), t]));
  const sessions = new Map<string, any>((await AcademicSession.find({ _id: { $in: [...terms.values()].map((t) => t.sessionId) } }).lean()).map((s: any) => [String(s._id), s]));
  const out: any[] = [];
  for (const tr of trs.sort((a, b) => String(terms.get(String(b.termId))?.startDate).localeCompare(String(terms.get(String(a.termId))?.startDate)))) {
    const term = terms.get(String(tr.termId));
    if (!term) continue;
    const block = family ? await resultBlock(studentId, tr) : { blocked: false as const };
    const row: any = { termId: String(term._id), term: term.number, session: sessions.get(String(term.sessionId))?.name, published: !!tr.published, imported: tr.source === 'imported', revision: tr.revision ?? 0, blocked: block.blocked, ...(block.blocked ? { balanceKobo: (block as any).balanceKobo, message: (block as any).message } : {}) };
    if (!block.blocked) {
      const scores: any[] = await Score.find({ termId: term._id, studentId }).lean();
      const subjects = new Map<string, any>((await Subject.find({ _id: { $in: scores.map((s) => s.subjectId) } }).lean()).map((s: any) => [String(s._id), s]));
      Object.assign(row, {
        average: tr.average ?? null,
        total: tr.total ?? null,
        position: tr.position ?? null,
        classSize: tr.classSize,
        subjectsCount: tr.subjectsCount,
        attendance: tr.attendance,
        teacherComment: tr.teacherComment,
        principalComment: tr.principalComment,
        ratings: tr.ratings,
        promotionOutcome: tr.promotionOutcome,
        verificationCode: tr.verificationCode,
        subjects: scores.map((s) => ({ subjectId: String(s.subjectId), name: subjects.get(String(s.subjectId))?.name, components: s.components, absent: s.absent, exempt: !!s.exempt, total: s.total, grade: s.grade, remark: s.remark, position: s.subjectPosition, classAverage: s.classAverage, highest: s.highest, lowest: s.lowest })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        reportCardReady: !!tr.reportCard?.file
      });
    } else row.reportCardReady = !!tr.reportCard?.file;
    out.push(row);
  }
  return out;
}

export async function reportCardLink(studentId: string, termId?: string) {
  const access = await assertCanSeeStudent(studentId);
  const term: any = await resolveTerm(termId);
  const tr: any = await need(TermResult.findOne({ termId: term._id, studentId }).lean(), 'Report card');
  const family = access === 'children' || access === 'self';
  if (family && !tr.published) throw notFound('Report card');
  if (family) {
    const block = await resultBlock(studentId, tr);
    if (block.blocked) throw new AppError('forbidden', (block as any).message, { details: { blocked: true, balanceKobo: (block as any).balanceKobo } });
  }
  if (!tr.reportCard?.file) {
    if (tr.source === 'imported') throw notFound('Report card');
    throw new AppError('state_conflict', 'The report card is still being prepared. Try again in a minute.');
  }
  return { url: files.link(tr.reportCard.file, 300), expiresIn: 300, revision: tr.revision ?? 0 };
}

/** Staff lift the block for one student, for one term. */
export async function unblockStudent(studentId: string, termId?: string) {
  const term: any = await resolveTerm(termId);
  await need(Student.findById(studentId).select('_id').lean(), 'Student');
  const res = await TermResult.updateOne({ termId: term._id, studentId }, { $set: { blockLifted: true, blockLiftedBy: me().userId } });
  if (!res.matchedCount) throw notFound('Result');
  await audit({ action: 'results.unblock', entityType: 'student', entityId: studentId, after: { termId: String(term._id) } });
  return { blockLifted: true };
}

export { ClassLevel, Enrolment, LevelGroup, Trait, can, studentAccess, myChildIds, currentSession, studentTermTotals };
