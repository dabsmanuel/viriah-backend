import { audit } from '../core/audit';
import { tx } from '../core/db';
import { AppError, forbidden, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { can, me } from '../core/http';
import { annualAverage, annualPositions, computeAnnualSubjects } from '../calc/annual';
import { attendancePercent } from '../calc/results';
import { propose, type Outcome } from '../calc/promotion';
import { enqueue, registerJob } from '../jobs/queue';
import {
  AcademicSession, AnnualResult, AttendanceRegister, ClassArm, ClassLevel, ClassSubject, Enrolment, Invoice, Membership, PromotionDecision, PromotionList, PromotionRule, RolloverRun, Score, Staff, Student, StudentSubject,
  Subject, TeachingAssignment, Task, Term, TermResult
} from '../models';
import { armContext, armStudents } from './academics';
import { termTotals } from './attendance';
import { fullName, loadSchool, need, staffRecipients } from './common';
import { notify } from './notify';
import { assertCanSeeStudent, assertClassTeacherOf, currentSession, hasFullReach, myTeaching, resolveTerm } from './reach';
import { classNames } from './students';
import { outcomeText, resultBlock, resultHooks } from './results';
import { photoUrl } from './common';

/** Annual results, rule-based promotion and session rollover (PRO-01 to PRO-08, RES-09, ACA-09, flows F14 and F15). */

// ------------------------------------------------------------------ rules (versioned)

export async function rulesOverview() {
  const [levels, rules] = await Promise.all([ClassLevel.find({}).sort({ order: 1 }).lean(), PromotionRule.find({ active: true }).lean()]);
  const byLevel = new Map<string, any>((rules as any[]).map((r) => [String(r.classLevelId), r]));
  return (levels as any[]).map((l) => ({ classLevelId: String(l._id), level: l.name, isFinal: !!l.isFinal, nextLevelId: l.nextLevelId ? String(l.nextLevelId) : null, rule: byLevel.get(String(l._id)) ? ruleView(byLevel.get(String(l._id))) : null }));
}

const ruleView = (r: any) => ({ id: String(r._id), version: r.version, minAnnualAverage: r.minAnnualAverage ?? null, mustPassSubjectIds: (r.mustPassSubjectIds ?? []).map(String), minSubjectsPassed: r.minSubjectsPassed ?? null, minAttendancePercent: r.minAttendancePercent ?? null, trial: r.trial ?? { enabled: false } });

export interface RuleInput {
  minAnnualAverage?: number | null;
  mustPassSubjectIds?: string[];
  minSubjectsPassed?: number | null;
  minAttendancePercent?: number | null;
  trial?: { enabled: boolean; minAnnualAverage?: number | null; maxFailedMustPass?: number };
}

/** Editing a rule creates a new version and does not alter stored proposals. Any condition can be switched off (null). */
export async function saveRule(levelId: string, input: RuleInput) {
  await need(ClassLevel.findById(levelId).lean(), 'Class level');
  if (input.mustPassSubjectIds?.length) {
    const ok = await ClassSubject.countDocuments({ classLevelId: levelId, subjectId: { $in: input.mustPassSubjectIds } });
    if (ok !== input.mustPassSubjectIds.length) throw validation('A must-pass subject is not taught at this level.', { mustPassSubjectIds: 'Not taught at this level.' });
  }
  const prev: any = await PromotionRule.findOne({ classLevelId: levelId, active: true });
  const version = (prev?.version ?? 0) + 1;
  if (prev) {
    prev.active = false;
    await prev.save();
  }
  const rule = await PromotionRule.create({ classLevelId: levelId, version, active: true, ...input });
  await audit({ action: 'promotion.rule.save', entityType: 'promotionRule', entityId: rule._id, before: prev ? ruleView(prev) : undefined, after: ruleView(rule) });
  return rule;
}

export async function ruleVersions(levelId: string) {
  const rows = await PromotionRule.find({ classLevelId: levelId }).sort({ version: -1 }).lean();
  return (rows as any[]).map((r) => ({ ...ruleView(r), active: r.active, createdAt: r.createdAt }));
}

// ------------------------------------------------------------------ annual results

async function termsOf(sessionId: unknown) {
  return (await Term.find({ sessionId }).sort({ number: 1 }).lean()) as any[];
}

/**
 * The system builds the annual result for each student from the three term results: per subject the three term totals and
 * their average (or the third term only, by the school's setting), the annual grade, annual average and position.
 * A student who joined in second or third term uses the terms they have.
 */
export async function buildAnnualForArm(sessionId: string, armId: string) {
  const school: any = await loadSchool();
  const ac = await armContext(armId);
  if (!ac.scale) throw validation('This class has no grading scale yet.');
  const terms = await termsOf(sessionId);
  const numberOf = new Map<string, 1 | 2 | 3>(terms.map((t) => [String(t._id), t.number]));
  const students = await armStudents(armId, sessionId);
  const scoreDocs: any[] = await Score.find({ termId: { $in: terms.map((t) => t._id) }, studentId: { $in: students.map((s) => s._id) }, total: { $ne: null } }).lean();
  const names = new Map<string, any>((await Subject.find({ _id: { $in: [...new Set(scoreDocs.map((s) => String(s.subjectId)))] } }).lean()).map((s: any) => [String(s._id), s]));
  const trs: any[] = await TermResult.find({ termId: { $in: terms.map((t) => t._id) }, studentId: { $in: students.map((s) => s._id) } }).lean();
  const method = school.settings?.annualMethod ?? 'mean_of_terms';

  const rows: any[] = [];
  for (const s of students) {
    const mine = scoreDocs.filter((x) => String(x.studentId) === String(s._id) && !x.exempt);
    const bySubject = new Map<string, Partial<Record<1 | 2 | 3, number>>>();
    for (const x of mine) {
      const sid = String(x.subjectId);
      if (!bySubject.has(sid)) bySubject.set(sid, {});
      bySubject.get(sid)![numberOf.get(String(x.termId))!] = x.total;
    }
    const subjects = computeAnnualSubjects([...bySubject.entries()].map(([subjectId, termsMap]) => ({ subjectId, name: names.get(subjectId)?.name, terms: termsMap })), ac.scale, method);
    const myTrs = trs.filter((t) => String(t.studentId) === String(s._id));
    const present = myTrs.reduce((a, t) => a + (t.attendance?.present ?? 0), 0);
    const opened = myTrs.reduce((a, t) => a + (t.attendance?.opened ?? 0), 0);
    const termsCounted = [...new Set(mine.map((x) => numberOf.get(String(x.termId))!))].sort();
    rows.push({ studentId: s._id, subjects, average: annualAverage(subjects), termsCounted, attendancePercent: attendancePercent(present, opened) });
  }
  const pos = annualPositions(rows.map((r) => ({ studentId: String(r.studentId), average: r.average })), !!ac.group.showPositions);
  for (const r of rows) {
    await AnnualResult.updateOne(
      { sessionId, studentId: r.studentId },
      { $set: { classArmId: armId, subjects: r.subjects.map((x: any) => ({ subjectId: x.subjectId, name: x.name, t1: x.t1, t2: x.t2, t3: x.t3, average: x.average, grade: x.grade, remark: x.remark })), average: r.average, position: pos.get(String(r.studentId)) ?? null, classSize: rows.length, termsCounted: r.termsCounted, attendancePercent: r.attendancePercent }, $setOnInsert: { sessionId, studentId: r.studentId } },
      { upsert: true }
    );
  }
  return rows.length;
}

// ------------------------------------------------------------------ proposals

async function listDoc(sessionId: unknown, armId: string) {
  await PromotionList.updateOne({ sessionId, classArmId: armId }, { $setOnInsert: { sessionId, classArmId: armId, status: 'proposed' } }, { upsert: true });
  return PromotionList.findOne({ sessionId, classArmId: armId }) as Promise<any>;
}

/**
 * After third-term results are approved, the system applies the rules to every student and proposes an outcome, listing
 * which conditions were met and which were not. A proposal is never overwritten by a staff override: the override is stored beside it.
 */
export async function proposeForArm(sessionId: string, armId: string) {
  const ac = await armContext(armId);
  const list = await listDoc(sessionId, armId);
  if (['approved', 'applied'].includes(list.status)) throw stateConflict('This list is already approved. Return it before running the rules again.');
  await buildAnnualForArm(sessionId, armId);
  const rule: any = await PromotionRule.findOne({ classLevelId: ac.level._id, active: true }).lean();
  const annuals: any[] = await AnnualResult.find({ sessionId, classArmId: armId }).lean();
  let n = 0;
  for (const a of annuals) {
    const result = propose({ average: a.average ?? null, attendancePercent: a.attendancePercent ?? null, subjects: (a.subjects ?? []).map((s: any) => ({ subjectId: String(s.subjectId), average: s.average ?? null })) }, rule ? { minAnnualAverage: rule.minAnnualAverage, mustPassSubjectIds: (rule.mustPassSubjectIds ?? []).map(String), minSubjectsPassed: rule.minSubjectsPassed, minAttendancePercent: rule.minAttendancePercent, trial: rule.trial } : null, ac.scale.passMark, { isFinal: !!ac.level.isFinal });
    const note = (a.termsCounted?.length ?? 0) > 0 && a.termsCounted.length < 3 ? `Joined part way through the year: the annual average uses ${a.termsCounted.length} term${a.termsCounted.length === 1 ? '' : 's'}.` : undefined;
    await PromotionDecision.updateOne(
      { sessionId, studentId: a.studentId },
      { $set: { classArmId: armId, ruleId: rule?._id, ruleVersion: rule?.version, proposed: result, note }, $setOnInsert: { sessionId, studentId: a.studentId } },
      { upsert: true }
    );
    n += 1;
  }
  if (list.status === 'reviewed') {
    list.status = 'proposed';
    await list.save();
  }
  await audit({ action: 'promotion.propose', entityType: 'promotionList', entityId: list._id, after: { students: n, ruleVersion: rule?.version ?? null } });
  return n;
}

registerJob('build-annual-results', async ({ payload }) => {
  const sessionId = payload.sessionId as string;
  const n = await proposeForArm(sessionId, payload.classArmId);
  return { students: n };
});

/** Third-term approval triggers the annual result and the proposals for that class arm. */
resultHooks.onApproved = async (termId, armId) => {
  await onThirdTermApproved(termId, armId);
};

export async function onThirdTermApproved(termId: unknown, armId: string) {
  const term: any = await Term.findById(termId).lean();
  if (!term || term.number !== 3) return null;
  return enqueue('build-annual-results', { sessionId: String(term.sessionId), classArmId: armId }, { schoolId: me().schoolId, userId: me().userId });
}

export async function proposeNow(armId: string, sessionId?: string) {
  const sid = sessionId ?? String((await currentSession())?._id);
  if (!hasFullReach()) await assertClassTeacherOf(armId, true);
  return enqueue('build-annual-results', { sessionId: sid, classArmId: armId }, { schoolId: me().schoolId, userId: me().userId });
}

// ------------------------------------------------------------------ the list: review, override, approve

const effective = (d: any): Outcome => (d.final?.outcome ?? d.proposed?.outcome ?? 'undecided') as Outcome;

export async function listsOverview(sessionId?: string) {
  const session: any = sessionId ? await need(AcademicSession.findById(sessionId).lean(), 'Session') : await currentSession();
  if (!session) return { sessionId: null, lists: [] };
  const arms: any[] = await ClassArm.find({ active: true }).lean();
  const enrolled = await Enrolment.aggregate([{ $match: { sessionId: session._id, to: { $exists: false } } }, { $group: { _id: '$classArmId', n: { $sum: 1 } } }]);
  const counts = new Map<string, number>(enrolled.map((e: any) => [String(e._id), e.n]));
  const lists: any[] = await PromotionList.find({ sessionId: session._id }).lean();
  const names = await classNames(arms.map((a) => String(a._id)));
  const t = await myTeaching();
  const seeAll = hasFullReach() || me().roles.includes('principal');
  return {
    sessionId: String(session._id),
    session: session.name,
    lists: arms
      .filter((a) => (counts.get(String(a._id)) ?? 0) > 0 && (seeAll || t.classTeacherArms.has(String(a._id))))
      .map((a) => {
        const l = lists.find((x) => String(x.classArmId) === String(a._id));
        return { classArmId: String(a._id), class: names.get(String(a._id))?.name, students: counts.get(String(a._id)) ?? 0, status: l?.status ?? 'not_started', reviewedAt: l?.reviewedAt, approvedAt: l?.approvedAt, returnNote: l?.returnNote };
      })
  };
}

export async function listView(armId: string, sessionId?: string) {
  const session: any = sessionId ? await need(AcademicSession.findById(sessionId).lean(), 'Session') : await currentSession();
  if (!session) throw validation('There is no current session.');
  const t = await myTeaching();
  if (!(hasFullReach() || me().roles.includes('principal') || t.classTeacherArms.has(armId))) throw notFound('Class');
  const list = await listDoc(session._id, armId);
  const ac = await armContext(armId);
  const decisions: any[] = await PromotionDecision.find({ sessionId: session._id, classArmId: armId }).lean();
  const annuals = new Map<string, any>((await AnnualResult.find({ sessionId: session._id, classArmId: armId }).lean()).map((a: any) => [String(a.studentId), a]));
  const students = new Map<string, any>((await Student.find({ _id: { $in: decisions.map((d) => d.studentId) } }).select('firstName lastName admissionNumber photo').lean()).map((s: any) => [String(s._id), s]));
  const subjectNames = new Map<string, string>((await Subject.find({}).select('name').lean()).map((s: any) => [String(s._id), s.name]));
  const label = (c: any) => (c.condition.startsWith('must_pass:') ? { ...c, label: `Must pass ${subjectNames.get(c.condition.slice(10)) ?? 'subject'}`, condition: `must_pass:${subjectNames.get(c.condition.slice(10)) ?? c.condition.slice(10)}` } : { ...c, label: ({ annual_average: 'Annual average', subjects_passed: 'Subjects passed', attendance: 'Attendance' } as Record<string, string>)[c.condition] ?? c.condition });
  const next = ac.level.nextLevelId ? await ClassLevel.findById(ac.level.nextLevelId).select('name').lean() : null;
  return {
    sessionId: String(session._id),
    classArmId: armId,
    status: list.status,
    returnNote: list.returnNote,
    isFinalClass: !!ac.level.isFinal,
    nextClass: (next as any)?.name ?? null,
    students: decisions
      .map((d) => ({
        id: String(d._id),
        studentId: String(d.studentId),
        name: fullName(students.get(String(d.studentId))),
        admissionNumber: students.get(String(d.studentId))?.admissionNumber,
        photoUrl: photoUrl(students.get(String(d.studentId))?.photo),
        annualAverage: annuals.get(String(d.studentId))?.average ?? null,
        attendancePercent: annuals.get(String(d.studentId))?.attendancePercent ?? null,
        proposed: { outcome: d.proposed?.outcome, checks: (d.proposed?.checks ?? []).map(label) },
        final: d.final?.outcome ? { outcome: d.final.outcome, reason: d.final.reason, by: d.final.by ? String(d.final.by) : undefined, at: d.final.at } : null,
        outcome: effective(d),
        ruleVersion: d.ruleVersion ?? null,
        note: d.note
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

/** The class teacher can change an outcome and must write a reason. The proposal is never overwritten. */
export async function setFinalOutcome(decisionId: string, outcome: Outcome, reason: string) {
  const c = me();
  const d: any = await need(PromotionDecision.findById(decisionId), 'Decision');
  const list = await listDoc(d.sessionId, String(d.classArmId));
  const isPrincipal = c.roles.includes('principal') || c.roles.includes('owner');
  if (!isPrincipal) await assertClassTeacherOf(String(d.classArmId), false);
  if (['approved', 'applied'].includes(list.status)) throw stateConflict('This list is approved. Return it first to change an outcome.');
  if (list.status === 'reviewed' && !isPrincipal) throw stateConflict('The list is with the principal. Only the principal can change it now.');
  const ac = await armContext(d.classArmId);
  if (outcome === 'graduated' && !ac.level.isFinal) throw validation('Only the school’s final class can graduate.', { outcome: 'Not the final class.' });
  if (outcome === 'promoted' && ac.level.isFinal) throw validation('The final class graduates instead of moving up.', { outcome: 'Use graduated.' });
  if (outcome === 'promoted_on_trial' && ac.level.isFinal) throw validation('Promotion on trial does not apply to the final class.', { outcome: 'Not allowed here.' });
  const before = { outcome: effective(d), final: d.final?.outcome };
  d.final = { outcome, by: c.userId, reason, at: new Date() };
  await d.save();
  await audit({ action: 'promotion.override', entityType: 'promotionDecision', entityId: d._id, before, after: { outcome, proposed: d.proposed?.outcome }, reason });
  return d;
}

export async function submitList(armId: string, sessionId?: string) {
  const c = me();
  const session: any = sessionId ? await need(AcademicSession.findById(sessionId).lean(), 'Session') : await currentSession();
  await assertClassTeacherOf(armId, false);
  const list = await listDoc(session._id, armId);
  assertTransition('promotionList', list.status, 'reviewed', 'This promotion list');
  const decisions: any[] = await PromotionDecision.find({ sessionId: session._id, classArmId: armId }).lean();
  if (!decisions.length) throw stateConflict('There are no proposals yet. The annual results are built after third-term results are approved.');
  const open = decisions.filter((d) => effective(d) === 'undecided');
  if (open.length) throw new AppError('state_conflict', `${open.length} student${open.length === 1 ? ' still needs' : 's still need'} an outcome. Choose one and write a reason.`, { details: { undecided: open.map((d) => String(d.studentId)) } });
  list.status = 'reviewed';
  list.reviewedBy = c.userId;
  list.reviewedAt = new Date();
  list.returnNote = undefined;
  await list.save();
  await audit({ action: 'promotion.submit', entityType: 'promotionList', entityId: list._id });
  const names = await classNames([armId]);
  await notify({ event: 'approval_event', to: (await staffRecipients(c.schoolId!, ['principal', 'owner'])).map((r) => ({ ...r, kind: 'staff' as const })), vars: { title: 'Promotion list to approve', body: `${names.get(armId)?.name ?? 'A class'} promotion list is waiting for approval.` } });
  return list;
}

export async function approveList(armId: string, sessionId?: string) {
  const c = me();
  const session: any = sessionId ? await need(AcademicSession.findById(sessionId).lean(), 'Session') : await currentSession();
  const list = await listDoc(session._id, armId);
  assertTransition('promotionList', list.status, 'approved', 'This promotion list');
  list.status = 'approved';
  list.approvedBy = c.userId;
  list.approvedAt = new Date();
  await list.save();
  await audit({ action: 'promotion.approve', entityType: 'promotionList', entityId: list._id });

  // The promotion outcome prints on the third-term report card and shows in the parent and student portals.
  const third: any = await Term.findOne({ sessionId: session._id, number: 3 }).lean();
  const decisions: any[] = await PromotionDecision.find({ sessionId: session._id, classArmId: armId }).lean();
  if (third) {
    for (const d of decisions) await TermResult.updateOne({ termId: third._id, studentId: d.studentId }, { promotionOutcome: outcomeText(effective(d)) });
    if (await TermResult.exists({ termId: third._id, classArmId: armId, published: true })) await enqueue('generate-report-cards', { termId: String(third._id), classArmId: armId, revised: false }, { schoolId: c.schoolId, userId: c.userId });
  }
  return list;
}

export async function returnList(armId: string, note: string, sessionId?: string) {
  const session: any = sessionId ? await need(AcademicSession.findById(sessionId).lean(), 'Session') : await currentSession();
  const list = await listDoc(session._id, armId);
  assertTransition('promotionList', list.status, 'proposed', 'This promotion list');
  list.status = 'proposed';
  list.returnNote = note;
  await list.save();
  await audit({ action: 'promotion.return', entityType: 'promotionList', entityId: list._id, reason: note });
  return list;
}

// ------------------------------------------------------------------ rollover

interface Move {
  studentId: string;
  name: string;
  fromLevelId: string;
  fromArmId: string;
  outcome: Outcome;
  toLevelId?: string;
  toArmId?: string;
  alumni: boolean;
  problem?: string;
}

export async function rolloverPreview(fromSessionId?: string, toSessionId?: string, armMode: 'keep' | 'manual' = 'keep', manualArms: Record<string, string> = {}) {
  const from: any = fromSessionId ? await need(AcademicSession.findById(fromSessionId).lean(), 'Session') : await currentSession();
  if (!from) throw validation('There is no current session to roll over.');
  const to: any = toSessionId ? await need(AcademicSession.findById(toSessionId).lean(), 'Session') : await AcademicSession.findOne({ status: 'upcoming' }).sort({ name: 1 }).lean();
  const blockers: Array<{ kind: string; message: string; classArmId?: string }> = [];
  if (!to) blockers.push({ kind: 'no_new_session', message: 'Create the new session and its terms first.' });
  if (to && to.status !== 'upcoming') blockers.push({ kind: 'bad_new_session', message: 'The new session must be upcoming.' });

  const run = await RolloverRun.findOne({ fromSessionId: from._id, status: 'done' }).lean();
  if (run) blockers.push({ kind: 'already_done', message: 'This session was already rolled over. Undo it first if nothing has happened in the new session.' });

  const enrolments: any[] = await Enrolment.find({ sessionId: from._id, to: { $exists: false } }).lean();
  const students = new Map<string, any>((await Student.find({ _id: { $in: enrolments.map((e) => e.studentId) }, status: 'active' }).select('firstName lastName').lean()).map((s: any) => [String(s._id), s]));
  const levels = new Map<string, any>((await ClassLevel.find({}).lean()).map((l: any) => [String(l._id), l]));
  const arms: any[] = await ClassArm.find({ active: true }).lean();
  const decisions = new Map<string, any>((await PromotionDecision.find({ sessionId: from._id }).lean()).map((d: any) => [String(d.studentId), d]));
  const lists = new Map<string, any>((await PromotionList.find({ sessionId: from._id }).lean()).map((l: any) => [String(l.classArmId), l]));

  // Rollover is blocked while any list is unapproved.
  const armIds = [...new Set(enrolments.filter((e) => students.has(String(e.studentId))).map((e) => String(e.classArmId)))];
  const names = await classNames(armIds);
  for (const a of armIds) {
    const st = lists.get(a)?.status;
    if (!['approved', 'applied'].includes(st)) blockers.push({ kind: 'list_not_approved', classArmId: a, message: `${names.get(a)?.name}: the promotion list is not approved yet.` });
  }

  const moves: Move[] = [];
  for (const e of enrolments) {
    const s = students.get(String(e.studentId));
    if (!s) continue;
    const d = decisions.get(String(e.studentId));
    const outcome = d ? effective(d) : 'undecided';
    const level = levels.get(String(e.classLevelId));
    const mv: Move = { studentId: String(e.studentId), name: fullName(s), fromLevelId: String(e.classLevelId), fromArmId: String(e.classArmId), outcome, alumni: false };
    if (outcome === 'graduated') mv.alumni = true;
    else if (outcome === 'repeat') {
      mv.toLevelId = String(e.classLevelId);
    } else if (outcome === 'promoted' || outcome === 'promoted_on_trial') {
      mv.toLevelId = level?.nextLevelId ? String(level.nextLevelId) : undefined;
      if (!mv.toLevelId) mv.problem = 'The progression map has no next class for this level.';
    } else mv.problem = 'No outcome chosen.';
    if (mv.toLevelId) {
      const lvlArms = arms.filter((a) => String(a.classLevelId) === mv.toLevelId);
      if (!lvlArms.length) {
        mv.problem = `${levels.get(mv.toLevelId)?.name ?? 'The next class'} has no arms yet. Create them first.`;
        blockers.push({ kind: 'no_arms', message: mv.problem });
      } else if (armMode === 'manual' && manualArms[mv.studentId]) {
        const chosen = lvlArms.find((a) => String(a._id) === manualArms[mv.studentId]);
        if (chosen) mv.toArmId = String(chosen._id);
        else mv.problem = 'The arm you chose is not in the next class.';
      } else if (armMode === 'keep') {
        const sameName = names.get(mv.fromArmId) ? arms.find((a) => String(a._id) === mv.fromArmId)?.name : undefined;
        mv.toArmId = String((lvlArms.find((a) => a.name === sameName) ?? lvlArms[0])._id);
      } else mv.problem = 'Choose an arm.';
    }
    if (mv.problem && !blockers.some((b) => b.message === mv.problem)) blockers.push({ kind: 'student', message: `${mv.name}: ${mv.problem}` });
    moves.push(mv);
  }
  const armNames = await classNames([...new Set(moves.map((m) => m.toArmId).filter(Boolean) as string[])]);
  const counts = { promoted: moves.filter((m) => m.outcome === 'promoted').length, promotedOnTrial: moves.filter((m) => m.outcome === 'promoted_on_trial').length, repeat: moves.filter((m) => m.outcome === 'repeat').length, graduated: moves.filter((m) => m.alumni).length };
  return {
    fromSessionId: String(from._id),
    fromSession: from.name,
    toSessionId: to ? String(to._id) : null,
    toSession: to?.name ?? null,
    armMode,
    canRun: blockers.length === 0,
    blockers: blockers.filter((b, i, arr) => arr.findIndex((x) => x.message === b.message) === i),
    counts,
    students: moves.map((m) => ({ ...m, currentClass: names.get(m.fromArmId)?.name, nextClass: m.alumni ? 'Alumni' : m.toArmId ? armNames.get(m.toArmId)?.name : null }))
  };
}

/**
 * Rollover writes a new enrolment record for each student in the new session, marks graduates as alumni, closes the old
 * session and opens the first term of the new one. Teacher assignments are copied forward as a draft for the admin to confirm.
 * One transaction per class arm. Running it twice creates no duplicates.
 */
export async function runRollover(input: { fromSessionId?: string; toSessionId: string; armMode: 'keep' | 'manual'; manualArms?: Record<string, string> }) {
  const c = me();
  const preview = await rolloverPreview(input.fromSessionId, input.toSessionId, input.armMode, input.manualArms ?? {});
  if (!preview.canRun) throw new AppError('state_conflict', 'Rollover is blocked.', { details: { blockers: preview.blockers } });
  return enqueue('session-rollover', { ...input, fromSessionId: preview.fromSessionId, byUserId: c.userId }, { schoolId: c.schoolId, userId: c.userId });
}

registerJob('session-rollover', async ({ payload, schoolId, progress }) => {
  const pv = await rolloverPreview(payload.fromSessionId, payload.toSessionId, payload.armMode, payload.manualArms ?? {});
  if (!pv.canRun) throw new Error(`Rollover is blocked: ${pv.blockers.map((b) => b.message).join('; ')}`);
  const from = pv.fromSessionId;
  const to = pv.toSessionId!;
  const byArm = new Map<string, typeof pv.students>();
  for (const m of pv.students) byArm.set(m.fromArmId, [...(byArm.get(m.fromArmId) ?? []), m]);

  const moves: any[] = [];
  let done = 0;
  for (const [armId, list] of byArm) {
    await tx(async (session) => {
      for (const m of list) {
        // idempotent: an enrolment that already exists in the new session is left alone
        const exists = await Enrolment.findOne({ studentId: m.studentId, sessionId: to }).session(session ?? null).lean();
        const old: any = await Enrolment.findOne({ studentId: m.studentId, sessionId: from }).session(session ?? null);
        if (old) {
          old.to = old.to ?? new Date().toISOString().slice(0, 10);
          old.outcome = m.outcome;
          await old.save({ session });
        }
        if (m.alumni) {
          await Student.updateOne({ _id: m.studentId }, { status: 'graduated', alumni: true, $push: { statusHistory: { status: 'graduated', at: new Date(), date: new Date().toISOString().slice(0, 10), reason: 'Completed the final class', by: payload.byUserId } } }, { session });
          const stu: any = await Student.findById(m.studentId).select('userId').session(session ?? null).lean();
          if (stu?.userId) await Membership.updateMany({ userId: stu.userId, kind: 'student' }, { status: 'deactivated', $inc: { permVersion: 1 } }, { session });
          moves.push({ studentId: m.studentId, outcome: m.outcome });
          continue;
        }
        if (!exists) {
          const [created] = await Enrolment.create([{ studentId: m.studentId, sessionId: to, classLevelId: m.toLevelId, classArmId: m.toArmId, from: new Date().toISOString().slice(0, 10) }], { session });
          await Student.updateOne({ _id: m.studentId }, { currentEnrolmentId: created._id }, { session });
          moves.push({ studentId: m.studentId, toLevelId: m.toLevelId, toArmId: m.toArmId, outcome: m.outcome, enrolmentId: created._id });
        }
      }
      await PromotionList.updateOne({ sessionId: from, classArmId: armId }, { status: 'applied' }, { session });
    });
    done += 1;
    await progress((done / byArm.size) * 80);
  }

  // Close the old session, open the new one with its first term.
  await tx(async (session) => {
    await Term.updateMany({ sessionId: from, status: { $ne: 'closed' } }, { status: 'closed', closedAt: new Date() }, { session });
    await AcademicSession.updateOne({ _id: from }, { status: 'closed' }, { session });
    await AcademicSession.updateOne({ _id: to }, { status: 'current' }, { session });
    await Term.updateOne({ sessionId: to, number: 1 }, { status: 'current' }, { session });
  });

  // Teacher assignments are copied forward as a draft for the admin to confirm.
  const oldAssignments: any[] = await TeachingAssignment.find({ sessionId: from }).lean();
  for (const a of oldAssignments) {
    await TeachingAssignment.updateOne(
      { sessionId: to, classArmId: a.classArmId, subjectId: a.subjectId ?? null, kind: a.kind },
      { $setOnInsert: { sessionId: to, classArmId: a.classArmId, ...(a.subjectId ? { subjectId: a.subjectId } : {}), staffId: a.staffId, kind: a.kind, draft: true } },
      { upsert: true }
    );
  }

  // Electives carry forward into the first term of the new session where the subject exists at the new level.
  const term1: any = await Term.findOne({ sessionId: to, number: 1 }).lean();
  const lastTerm: any = await Term.findOne({ sessionId: from, number: 3 }).lean();
  if (term1 && lastTerm) {
    const regs: any[] = await StudentSubject.find({ termId: lastTerm._id }).lean();
    for (const r of regs) {
      const mv = moves.find((m) => String(m.studentId) === String(r.studentId) && m.toLevelId);
      if (!mv) continue;
      const valid = (await ClassSubject.find({ classLevelId: mv.toLevelId, subjectId: { $in: r.subjectIds } }).lean()).map((x: any) => x.subjectId);
      if (valid.length) await StudentSubject.updateOne({ studentId: r.studentId, termId: term1._id }, { $setOnInsert: { studentId: r.studentId, termId: term1._id, subjectIds: valid } }, { upsert: true });
    }
  }

  await RolloverRun.create({ fromSessionId: from, toSessionId: to, status: 'done', armMode: payload.armMode, moves, createdBy: payload.byUserId });
  await audit({ action: 'session.rollover', entityType: 'session', entityId: to, schoolId, after: { students: moves.length, from, to } });
  return { moved: moves.length, graduates: moves.filter((m) => !m.toArmId && m.outcome === 'graduated').length };
});

/** Undo is allowed only while no attendance, score or invoice exists in the new session. */
export async function undoRollover() {
  const c = me();
  const run: any = await RolloverRun.findOne({ status: 'done' }).sort({ createdAt: -1 });
  if (!run) throw notFound('Rollover');
  const terms = (await Term.find({ sessionId: run.toSessionId }).select('_id').lean()).map((t: any) => t._id);
  const [att, sc, inv, tk] = await Promise.all([AttendanceRegister.exists({ termId: { $in: terms } }), Score.exists({ termId: { $in: terms } }), Invoice.exists({ termId: { $in: terms } }), Task.exists({ termId: { $in: terms } })]);
  if (att || sc || inv || tk) throw stateConflict('The new session already has attendance, scores, invoices or work, so the rollover cannot be undone.', { attendance: !!att, scores: !!sc, invoices: !!inv, tasks: !!tk });
  await tx(async (session) => {
    for (const m of run.moves) {
      if (m.enrolmentId) {
        await Enrolment.deleteOne({ _id: m.enrolmentId }, { session });
      }
      const old: any = await Enrolment.findOne({ studentId: m.studentId, sessionId: run.fromSessionId }).session(session ?? null);
      if (old) {
        old.to = undefined;
        old.outcome = undefined;
        await old.save({ session });
        await Student.updateOne({ _id: m.studentId }, { currentEnrolmentId: old._id }, { session });
      }
      if (m.outcome === 'graduated') {
        await Student.updateOne({ _id: m.studentId }, { status: 'active', alumni: false }, { session });
        const stu: any = await Student.findById(m.studentId).select('userId').session(session ?? null).lean();
        if (stu?.userId) await Membership.updateMany({ userId: stu.userId, kind: 'student' }, { status: 'active', $inc: { permVersion: 1 } }, { session });
      }
    }
    await TeachingAssignment.deleteMany({ sessionId: run.toSessionId, draft: true }, { session });
    await Term.updateMany({ sessionId: run.toSessionId }, { status: 'upcoming' }, { session });
    await AcademicSession.updateOne({ _id: run.toSessionId }, { status: 'upcoming' }, { session });
    await AcademicSession.updateOne({ _id: run.fromSessionId }, { status: 'current' }, { session });
    // the old third term is current again
    await Term.updateMany({ sessionId: run.fromSessionId }, { status: 'closed' }, { session });
    await Term.updateOne({ sessionId: run.fromSessionId, number: 3 }, { status: 'current' }, { session });
    await PromotionList.updateMany({ sessionId: run.fromSessionId, status: 'applied' }, { status: 'approved' }, { session });
    run.status = 'undone';
    await run.save({ session });
  });
  await audit({ action: 'session.rollover.undo', entityType: 'session', entityId: run.toSessionId, by: c.userId } as any);
  return { undone: true };
}

// ------------------------------------------------------------------ annual result for the portals

export async function annualForStudent(studentId: string, sessionId?: string) {
  const access = await assertCanSeeStudent(studentId);
  const session: any = sessionId ? await need(AcademicSession.findById(sessionId).lean(), 'Session') : await currentSession();
  if (!session) throw validation('Choose a session.');
  const a: any = await AnnualResult.findOne({ sessionId: session._id, studentId }).lean();
  if (!a) throw notFound('Annual result');
  const third: any = await Term.findOne({ sessionId: session._id, number: 3 }).lean();
  const tr: any = third ? await TermResult.findOne({ termId: third._id, studentId }).lean() : null;
  if ((access === 'children' || access === 'self') && !tr?.published) throw notFound('Annual result');
  if (access === 'children' || access === 'self') {
    const block = await resultBlock(studentId, tr);
    if (block.blocked) return { blocked: true, message: (block as any).message, balanceKobo: (block as any).balanceKobo };
  }
  return { session: session.name, average: a.average, position: a.position, classSize: a.classSize, attendancePercent: a.attendancePercent, termsCounted: a.termsCounted, subjects: a.subjects, promotionOutcome: tr?.promotionOutcome ?? null };
}

export { can, forbidden, resolveTerm, Staff };
