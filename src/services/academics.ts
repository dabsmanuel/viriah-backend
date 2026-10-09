import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { tx } from '../core/db';
import { forbidden, notFound, stateConflict, termClosed, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { me } from '../core/http';
import { validateBands, validateStructure } from '../calc/results';
import {
  AcademicSession,
  AssessmentStructure,
  ClassArm,
  ClassLevel,
  ClassSubject,
  Enrolment,
  GradingScale,
  LevelGroup,
  Score,
  ScoreSheet,
  Student,
  StudentSubject,
  Subject,
  Term,
  TermResult,
  ClassResult
} from '../models';
import { need } from './common';

/** Sessions, terms, class levels, subjects and the grading rules everything else depends on (ACA, M3). */

// ------------------------------------------------------------------ terms and the closed-term guard

/** Closing a term locks its scores, attendance and results. Every module calls this before changing term records. */
export async function assertTermOpen(termId: unknown) {
  const t = await Term.findById(termId).select('status').lean();
  if (!t) throw notFound('Term');
  if (t.status === 'closed') throw termClosed();
  return t;
}

export interface TermInput {
  number: 1 | 2 | 3;
  startDate?: string;
  endDate?: string;
  nextTermBegins?: string;
}

const SESSION_NAME = /^(\d{4})\/(\d{4})$/;

export function validateSessionName(name: string) {
  const m = SESSION_NAME.exec(name);
  if (!m || Number(m[2]) !== Number(m[1]) + 1) throw validation('Write the session as two consecutive years, for example 2026/2027.', { name: 'Use a form like 2026/2027.' });
}

function validateTermDates(terms: TermInput[]) {
  const ordered = [...terms].sort((a, b) => a.number - b.number);
  let prevEnd: string | undefined;
  for (const t of ordered) {
    if (t.startDate && t.endDate && t.startDate > t.endDate) throw validation(`Term ${t.number} ends before it starts.`, { [`terms[${t.number - 1}].endDate`]: 'Must be after the start date.' });
    if (prevEnd && t.startDate && t.startDate <= prevEnd) throw validation(`Term ${t.number} starts before the previous term ends.`, { [`terms[${t.number - 1}].startDate`]: 'Must be after the previous term.' });
    if (t.endDate) prevEnd = t.endDate;
  }
}

/** A session has three terms. If the school has no current session yet, this one becomes current with its first term open. */
export async function createSession(input: { name: string; startDate?: string; endDate?: string; terms: TermInput[]; importedOnly?: boolean; makeCurrent?: boolean }) {
  validateSessionName(input.name);
  if (input.terms.length !== 3 || new Set(input.terms.map((t) => t.number)).size !== 3) throw validation('A session has exactly three terms.', { terms: 'Give terms 1, 2 and 3.' });
  validateTermDates(input.terms);
  if (await AcademicSession.exists({ name: input.name })) throw validation('A session with this name already exists.', { name: 'Already exists.' });

  const hasCurrent = !!(await AcademicSession.exists({ status: 'current' }));
  const current = !input.importedOnly && input.makeCurrent !== false && !hasCurrent;
  const status = input.importedOnly ? 'closed' : current ? 'current' : 'upcoming';

  const out = await tx(async (session) => {
    const [s] = await AcademicSession.create([{ name: input.name, startDate: input.startDate, endDate: input.endDate, status, importedOnly: !!input.importedOnly }], { session });
    const terms = await Term.create(
      input.terms.map((t) => ({
        sessionId: s._id,
        number: t.number,
        startDate: t.startDate,
        endDate: t.endDate,
        nextTermBegins: t.nextTermBegins,
        status: input.importedOnly ? 'closed' : current && t.number === 1 ? 'current' : 'upcoming'
      })),
      { session, ordered: true }
    );
    return { s, terms };
  });
  await audit({ action: 'academics.session.create', entityType: 'session', entityId: out.s._id, after: { name: input.name, status } });
  return out;
}

export async function sessionsWithTerms() {
  const sessions = await AcademicSession.find({}).sort({ name: -1 }).lean();
  const terms = await Term.find({}).sort({ number: 1 }).lean();
  return sessions.map((s: any) => ({ ...s, id: String(s._id), terms: terms.filter((t: any) => String(t.sessionId) === String(s._id)).map((t: any) => ({ ...t, id: String(t._id) })) }));
}

export async function updateSession(id: string, patch: { name?: string; startDate?: string; endDate?: string }) {
  const s: any = await need(AcademicSession.findById(id), 'Session');
  if (patch.name && patch.name !== s.name) {
    validateSessionName(patch.name);
    if (await AcademicSession.exists({ name: patch.name, _id: { $ne: id } })) throw validation('A session with this name already exists.', { name: 'Already exists.' });
  }
  Object.assign(s, patch);
  await s.save();
  return s;
}

export async function updateTerm(id: string, patch: { startDate?: string; endDate?: string; nextTermBegins?: string }) {
  const t: any = await need(Term.findById(id), 'Term');
  if (t.status === 'closed') throw termClosed();
  Object.assign(t, patch);
  const siblings = await Term.find({ sessionId: t.sessionId }).lean();
  validateTermDates(siblings.map((x: any) => (String(x._id) === id ? { number: t.number, startDate: t.startDate, endDate: t.endDate } : { number: x.number, startDate: x.startDate, endDate: x.endDate })));
  await t.save();
  return t;
}

/** Make this the current term. The previous current term is closed, and students' elective choices carry forward. */
export async function openTerm(id: string) {
  const term: any = await need(Term.findById(id), 'Term');
  assertTransition('period', term.status, 'current', 'This term');
  const session: any = await AcademicSession.findById(term.sessionId);
  const currentSession: any = await AcademicSession.findOne({ status: 'current' });
  if (currentSession && String(currentSession._id) !== String(session._id)) throw stateConflict('This term belongs to another session. Use session rollover to start a new session.');
  if (!currentSession) {
    session.status = 'current';
    await session.save();
  }
  const prev: any = await Term.findOne({ status: 'current' });
  await tx(async (s) => {
    if (prev) {
      prev.status = 'closed';
      prev.closedAt = new Date();
      await prev.save({ session: s });
    }
    term.status = 'current';
    await term.save({ session: s });
  });
  if (prev) await copyStudentSubjectsForward(String(prev._id), String(term._id));
  await audit({ action: 'academics.term.open', entityType: 'term', entityId: id, before: { previous: prev?._id }, after: { status: 'current' } });
  return term;
}

export async function closeTerm(id: string) {
  const term: any = await need(Term.findById(id), 'Term');
  assertTransition('period', term.status, 'closed', 'This term');
  term.status = 'closed';
  term.closedAt = new Date();
  await term.save();
  await audit({ action: 'academics.term.close', entityType: 'term', entityId: id });
  return term;
}

export async function reopenTerm(id: string, reason: string) {
  const c = me();
  const term: any = await need(Term.findById(id), 'Term');
  assertTransition('period', term.status, 'current', 'This term');
  if (await Term.exists({ status: 'current' })) throw stateConflict('Another term is open. Close it first, then reopen this one.');
  term.status = 'current';
  term.reopenLog.push({ at: new Date(), by: c.userId, reason });
  await term.save();
  await audit({ action: 'academics.term.reopen', entityType: 'term', entityId: id, reason });
  return term;
}

async function copyStudentSubjectsForward(fromTermId: string, toTermId: string) {
  const rows = await StudentSubject.find({ termId: fromTermId }).lean();
  for (const r of rows) await StudentSubject.updateOne({ studentId: r.studentId, termId: toTermId }, { $setOnInsert: { studentId: r.studentId, termId: toTermId, subjectIds: r.subjectIds } }, { upsert: true });
}

// ------------------------------------------------------------------ level groups, scales, structures

/** Context for any class arm: its level, level group, scale and structure. Used by scores, results and promotion. */
export async function armContext(armId: unknown) {
  const arm: any = await need(ClassArm.findById(armId).lean(), 'Class');
  const level: any = await need(ClassLevel.findById(arm.classLevelId).lean(), 'Class level');
  const group: any = await need(LevelGroup.findById(level.levelGroupId).lean(), 'Level group');
  const [scale, structure] = await Promise.all([group.gradingScaleId ? GradingScale.findById(group.gradingScaleId).lean() : null, group.assessmentStructureId ? AssessmentStructure.findById(group.assessmentStructureId).lean() : null]);
  return { arm, level, group, scale: scale as any, structure: structure as any };
}

async function armIdsOfGroup(groupIds: unknown[]) {
  const levels = await ClassLevel.find({ levelGroupId: { $in: groupIds } }).select('_id').lean();
  const arms = await ClassArm.find({ classLevelId: { $in: levels.map((l: any) => l._id) } }).select('_id').lean();
  return arms.map((a: any) => a._id);
}

/** An assessment structure cannot be edited once scores exist in the current term. */
export async function scoresExistForStructure(structureId: string): Promise<boolean> {
  const term = await Term.findOne({ status: 'current' }).select('_id').lean();
  if (!term) return false;
  const groups = await LevelGroup.find({ assessmentStructureId: structureId }).select('_id').lean();
  if (!groups.length) return false;
  const arms = await armIdsOfGroup(groups.map((g: any) => g._id));
  return !!(await Score.exists({ termId: term._id, classArmId: { $in: arms } }));
}

/** A grading scale cannot be edited if a published result in the current term uses it. */
export async function publishedResultUsesScale(scaleId: string): Promise<boolean> {
  const term = await Term.findOne({ status: 'current' }).select('_id').lean();
  if (!term) return false;
  const groups = await LevelGroup.find({ gradingScaleId: scaleId }).select('_id').lean();
  if (!groups.length) return false;
  const arms = await armIdsOfGroup(groups.map((g: any) => g._id));
  return !!(await ClassResult.exists({ termId: term._id, classArmId: { $in: arms }, status: { $in: ['published', 'reopened'] } }));
}

export function checkBands(bands: any[]) {
  const problem = validateBands(bands);
  if (problem) throw validation(problem, { bands: problem });
}
export function checkStructure(components: any[]) {
  const problem = validateStructure(components);
  if (problem) throw validation(problem, { components: problem });
}

export async function updateLevelGroup(id: string, patch: { gradingScaleId?: string; assessmentStructureId?: string; reportLayout?: 'scores' | 'ratings'; showPositions?: boolean }) {
  const g: any = await need(LevelGroup.findById(id), 'Level group');
  if (patch.assessmentStructureId && String(g.assessmentStructureId) !== patch.assessmentStructureId) {
    await need(AssessmentStructure.findById(patch.assessmentStructureId).lean(), 'Assessment structure');
    if (g.assessmentStructureId && (await scoresExistForStructure(String(g.assessmentStructureId)))) throw stateConflict('Scores already exist this term, so the assessment structure cannot change now.');
  }
  if (patch.gradingScaleId && String(g.gradingScaleId) !== patch.gradingScaleId) {
    await need(GradingScale.findById(patch.gradingScaleId).lean(), 'Grading scale');
    if (g.gradingScaleId && (await publishedResultUsesScale(String(g.gradingScaleId)))) throw stateConflict('A result using this scale is already published this term, so the scale cannot change now.');
  }
  Object.assign(g, patch);
  await g.save();
  await audit({ action: 'academics.level_group.update', entityType: 'levelGroup', entityId: id, after: patch });
  return g;
}

// ------------------------------------------------------------------ class levels and arms

async function assertNoCycle(levelId: string, nextId?: string) {
  let cur = nextId;
  const seen = new Set<string>([levelId]);
  while (cur) {
    if (seen.has(cur)) throw validation('That progression would loop back on itself.', { nextLevelId: 'Creates a loop.' });
    seen.add(cur);
    cur = String((await ClassLevel.findById(cur).select('nextLevelId').lean())?.nextLevelId ?? '') || undefined;
  }
}

export async function createClassLevel(input: { name: string; levelGroupId: string; order?: number; nextLevelId?: string; isFinal?: boolean; studentLogin?: boolean }) {
  await need(LevelGroup.findById(input.levelGroupId).lean(), 'Level group');
  if (await ClassLevel.exists({ name: input.name })) throw validation('A class level with this name already exists.', { name: 'Already exists.' });
  const count = await ClassLevel.countDocuments({});
  const level = await ClassLevel.create({ ...input, order: input.order ?? count + 1, nextLevelId: input.isFinal ? undefined : input.nextLevelId });
  await ClassArm.create({ classLevelId: level._id, name: 'A' });
  return level;
}

export async function updateClassLevel(id: string, patch: { name?: string; order?: number; nextLevelId?: string | null; isFinal?: boolean; studentLogin?: boolean; levelGroupId?: string; active?: boolean }) {
  const level: any = await need(ClassLevel.findById(id), 'Class level');
  if (patch.name && patch.name !== level.name && (await ClassLevel.exists({ name: patch.name, _id: { $ne: id } }))) throw validation('A class level with this name already exists.', { name: 'Already exists.' });
  if (patch.nextLevelId) await assertNoCycle(id, patch.nextLevelId);
  if (patch.levelGroupId) await need(LevelGroup.findById(patch.levelGroupId).lean(), 'Level group');
  const { nextLevelId, ...rest } = patch;
  Object.assign(level, rest);
  if (nextLevelId !== undefined) level.nextLevelId = nextLevelId ?? undefined;
  if (level.isFinal) level.nextLevelId = undefined; // the final level has no next level
  await level.save();
  return level;
}

/** A level that has never had students can be removed. */
export async function deleteClassLevel(id: string) {
  await need(ClassLevel.findById(id).lean(), 'Class level');
  if (await Enrolment.exists({ classLevelId: id })) throw stateConflict('This level has had students, so it cannot be removed. Switch it off instead.');
  if (await ClassLevel.exists({ nextLevelId: id })) throw stateConflict('Another level moves up into this one. Change its progression first.');
  await ClassArm.deleteMany({ classLevelId: id });
  await ClassSubject.deleteMany({ classLevelId: id });
  await ClassLevel.deleteOne({ _id: id });
}

export async function classLevelsWithArms() {
  const [levels, arms] = await Promise.all([ClassLevel.find({}).sort({ order: 1 }).lean(), ClassArm.find({}).sort({ name: 1 }).lean()]);
  return levels.map((l: any) => ({ ...l, id: String(l._id), arms: arms.filter((a: any) => String(a.classLevelId) === String(l._id)).map((a: any) => ({ ...a, id: String(a._id) })) }));
}

export async function createArm(classLevelId: string, name: string) {
  await need(ClassLevel.findById(classLevelId).lean(), 'Class level');
  if (await ClassArm.exists({ classLevelId, name })) throw validation('This class already has an arm with that name.', { name: 'Already exists.' });
  return ClassArm.create({ classLevelId, name });
}

export async function updateArm(id: string, patch: { name?: string; active?: boolean }) {
  const arm: any = await need(ClassArm.findById(id), 'Class');
  if (patch.name && patch.name !== arm.name && (await ClassArm.exists({ classLevelId: arm.classLevelId, name: patch.name, _id: { $ne: id } }))) throw validation('This class already has an arm with that name.', { name: 'Already exists.' });
  if (patch.active === false) {
    const session = await AcademicSession.findOne({ status: 'current' }).select('_id').lean();
    if (session && (await Enrolment.exists({ sessionId: session._id, classArmId: id }))) throw stateConflict('Students are in this class. Move them before switching it off.');
  }
  Object.assign(arm, patch);
  await arm.save();
  return arm;
}

// ------------------------------------------------------------------ subjects

export async function setLevelSubjects(levelId: string, items: Array<{ subjectId: string; compulsory: boolean; department?: 'science' | 'arts' | 'commercial' }>) {
  await need(ClassLevel.findById(levelId).lean(), 'Class level');
  const ids = items.map((i) => i.subjectId);
  if (new Set(ids).size !== ids.length) throw validation('A subject is listed twice.', { items: 'Duplicate subject.' });
  const found = await Subject.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) throw notFound('Subject');
  // A subject that already has scores in this level cannot be taken away.
  const existing = await ClassSubject.find({ classLevelId: levelId }).lean();
  const removed = existing.filter((e: any) => !ids.includes(String(e.subjectId)));
  if (removed.length) {
    const arms = (await ClassArm.find({ classLevelId: levelId }).select('_id').lean()).map((a: any) => a._id);
    const used = await Score.exists({ classArmId: { $in: arms }, subjectId: { $in: removed.map((r: any) => r.subjectId) } });
    if (used) throw stateConflict('Scores exist for a subject you are removing. It cannot be taken off this level.');
  }
  await ClassSubject.deleteMany({ classLevelId: levelId, subjectId: { $nin: ids } });
  for (const i of items) {
    await ClassSubject.updateOne({ classLevelId: levelId, subjectId: i.subjectId }, { $set: { compulsory: i.compulsory, department: i.department } }, { upsert: true });
  }
  return ClassSubject.find({ classLevelId: levelId }).lean();
}

/** The subjects a student offers this term: the compulsory ones plus the electives they registered. */
export async function subjectsOfStudent(studentId: string, termId: string, levelId: string) {
  const classSubjects: any[] = await ClassSubject.find({ classLevelId: levelId }).lean();
  const reg: any = await StudentSubject.findOne({ studentId, termId }).lean();
  const chosen = new Set((reg?.subjectIds ?? []).map(String));
  return classSubjects.filter((cs) => cs.compulsory || chosen.has(String(cs.subjectId)));
}

/** Allowed until the first score sheet for that subject is submitted. After that the principal must make the change. */
export async function setStudentSubjects(studentId: string, termId: string, subjectIds: string[], levelId: string, armId: string) {
  const c = me();
  const classSubjects: any[] = await ClassSubject.find({ classLevelId: levelId }).lean();
  const allowed = new Set(classSubjects.map((cs) => String(cs.subjectId)));
  for (const id of subjectIds) if (!allowed.has(id)) throw validation('One of these subjects is not taught at this level.', { subjectIds: 'Not offered at this level.' });
  const compulsory = classSubjects.filter((cs) => cs.compulsory).map((cs) => String(cs.subjectId));
  const wanted = new Set([...compulsory, ...subjectIds]);
  const prev: any = await StudentSubject.findOne({ studentId, termId }).lean();
  const before = new Set<string>([...compulsory, ...(prev?.subjectIds ?? []).map(String)]);
  const changed = [...wanted].filter((x) => !before.has(x)).concat([...before].filter((x) => !wanted.has(x)));
  if (changed.length) {
    const submitted = await ScoreSheet.find({ termId, classArmId: armId, subjectId: { $in: changed }, status: 'submitted' }).select('_id').lean();
    if (submitted.length && !(c.roles.includes('principal') || c.roles.includes('owner'))) throw forbidden('A score sheet for that subject is already submitted. Ask the principal to make this change.');
  }
  await StudentSubject.updateOne({ studentId, termId }, { $set: { subjectIds: subjectIds.filter((s) => !compulsory.includes(s)) } }, { upsert: true });
  await audit({ action: 'academics.student_subjects.update', entityType: 'student', entityId: studentId, before: [...before], after: [...wanted] });
  return [...wanted];
}

/** Active students enrolled in an arm for a session, in name order. */
export async function armStudents(armId: string, sessionId: unknown) {
  const e: any[] = await Enrolment.find({ sessionId, classArmId: armId, to: { $exists: false } }).select('studentId').lean();
  return Student.find({ _id: { $in: e.map((x) => x.studentId) }, status: 'active' }).select('firstName lastName admissionNumber gender photo').sort({ lastName: 1, firstName: 1 }).lean() as Promise<any[]>;
}

/**
 * The students in this arm who offer this subject this term: everyone for a compulsory subject, and only those who
 * registered for an elective. Results and positions count only the subjects a student offers.
 */
export async function subjectRoster(armId: string, subjectId: string, termId: string, sessionId: unknown) {
  const arm: any = await need(ClassArm.findById(armId).lean(), 'Class');
  const cs: any = await ClassSubject.findOne({ classLevelId: arm.classLevelId, subjectId }).lean();
  if (!cs) return [];
  const students = await armStudents(armId, sessionId);
  if (cs.compulsory) return students;
  const regs: any[] = await StudentSubject.find({ termId, studentId: { $in: students.map((s) => s._id) }, subjectIds: subjectId }).select('studentId').lean();
  const chosen = new Set(regs.map((r) => String(r.studentId)));
  return students.filter((s) => chosen.has(String(s._id)));
}

export { TermResult, getCtx };
