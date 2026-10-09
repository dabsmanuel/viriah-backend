import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { forbidden, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { can, me } from '../core/http';
import { round1 } from '../lib/rounding';
import { schoolLink } from '../lib/links';
import { formatDate } from '../lib/dates';
import { Enrolment, Guardian, Score, ScoreSheet, Student, StudentGuardian, Subject, Submission, Task, Term, ClassArm } from '../models';
import { armContext, armStudents, assertTermOpen, subjectRoster } from './academics';
import { fullName, loadSchool, need } from './common';
import { confirmMany } from './files';
import { notify } from './notify';
import { assertTeaches, currentSession, hasFullReach, myChildIds, myTeaching, resolveTerm } from './reach';
import { classNames } from './students';
import { photoUrl } from './common';

/** Assignments, homework, projects and tests (LRN-01 to LRN-07, flow F11). */

export interface TaskInput {
  termId?: string;
  classArmId: string;
  subjectId: string;
  type: 'assignment' | 'homework' | 'project' | 'test';
  title: string;
  instructions?: string;
  attachments?: string[];
  dueAt?: string;
  maxScore: number;
  lateRule: 'allow' | 'allow_flag' | 'close';
  allowResubmit: boolean;
  countsTo?: string;
  paper?: boolean;
}

async function assertComponent(armId: string, key?: string) {
  if (!key) return;
  const { structure } = await armContext(armId);
  if (!structure?.components?.some((c: any) => c.key === key)) throw validation('That is not a component on this class’s score sheet.', { countsTo: 'Choose a component of the assessment structure.' });
}

const fileObjs = (refs: string[]) => refs.map((ref) => ({ ref, name: ref.split('/').pop(), mime: undefined }));

/** A teacher can create a task only for a class arm and subject they teach. */
export async function createTask(input: TaskInput) {
  const c = me();
  await assertTeaches(input.classArmId, input.subjectId);
  const term = await resolveTerm(input.termId);
  await assertTermOpen(term._id);
  await assertComponent(input.classArmId, input.countsTo);
  const attachments = input.attachments?.length ? await confirmMany(input.attachments, 'task_file') : [];
  const task = await Task.create({ ...input, termId: term._id, staffId: c.staffId, attachments: fileObjs(attachments), dueAt: input.dueAt ? new Date(input.dueAt) : undefined, status: 'draft' });
  await audit({ action: 'tasks.create', entityType: 'task', entityId: task._id, after: { title: input.title, type: input.type } });
  return task;
}

/** Visible tasks: a teacher sees the ones for their own class arms and subjects; leadership sees all. */
export async function visibleTaskFilter() {
  if (hasFullReach() || me().roles.includes('principal')) return {};
  const t = await myTeaching();
  const ors = [...t.subjectsByArm.entries()].map(([arm, subs]) => ({ classArmId: arm, subjectId: { $in: [...subs] } }));
  return ors.length ? { $or: ors } : { _id: { $in: [] } };
}

export async function assertOwnTask(taskId: string, write = true) {
  const task: any = await need(Task.findById(taskId), 'Task');
  const c = me();
  if (!write && (hasFullReach() || c.roles.includes('principal'))) return task;
  const t = await myTeaching();
  if (!t.subjectsByArm.get(String(task.classArmId))?.has(String(task.subjectId))) throw notFound('Task');
  return task;
}

export async function updateTask(id: string, patch: Partial<TaskInput>) {
  const task: any = await assertOwnTask(id);
  await assertTermOpen(task.termId);
  if (patch.classArmId && patch.classArmId !== String(task.classArmId)) throw validation('A task cannot move to another class. Create a new one.', { classArmId: 'Cannot change.' });
  if (patch.subjectId && patch.subjectId !== String(task.subjectId)) throw validation('A task cannot move to another subject. Create a new one.', { subjectId: 'Cannot change.' });
  if (patch.maxScore !== undefined && patch.maxScore !== task.maxScore && (await Submission.exists({ taskId: id, status: 'marked' }))) throw stateConflict('Work is already marked, so the maximum score cannot change.');
  if (patch.countsTo !== undefined) await assertComponent(String(task.classArmId), patch.countsTo);
  const { attachments, dueAt, termId, ...rest } = patch;
  void termId;
  Object.assign(task, rest);
  if (dueAt !== undefined) task.dueAt = dueAt ? new Date(dueAt) : undefined;
  if (attachments) task.attachments = fileObjs(await confirmMany(attachments, 'task_file'));
  await task.save();
  return task;
}

export async function deleteTask(id: string) {
  const task: any = await assertOwnTask(id);
  if (task.status !== 'draft') throw stateConflict('Only a draft task can be deleted. Close it instead.');
  await Task.deleteOne({ _id: id });
}

/** On publish, students in that class arm who offer the subject (and their parents) are notified. */
export async function publishTask(id: string) {
  const task: any = await assertOwnTask(id);
  assertTransition('task', task.status, 'published', 'This task');
  await assertTermOpen(task.termId);
  task.status = 'published';
  task.publishedAt = task.publishedAt ?? new Date();
  await task.save();
  await audit({ action: 'tasks.publish', entityType: 'task', entityId: id });
  await notifyTaskPublished(task);
  return task;
}

async function notifyTaskPublished(task: any) {
  const session = await currentSession();
  if (!session) return;
  const students = await subjectRoster(String(task.classArmId), String(task.subjectId), String(task.termId), session._id);
  const subject: any = await Subject.findById(task.subjectId).select('name').lean();
  const school: any = await loadSchool();
  const recipients: any[] = [];
  const links: any[] = await StudentGuardian.find({ studentId: { $in: students.map((s) => s._id) }, access: { $ne: 'none' } }).lean();
  const guardians: any[] = await Guardian.find({ _id: { $in: [...new Set(links.map((l) => String(l.guardianId)))] } }).lean();
  for (const g of guardians) if (g.userId) recipients.push({ userId: String(g.userId), kind: 'parent' });
  // A student record has no userId in the lean select above, so look the students' users up.
  const withUsers: any[] = await Student.find({ _id: { $in: students.map((s) => s._id) }, userId: { $exists: true } }).select('userId').lean();
  for (const s of withUsers) recipients.push({ userId: String(s.userId), kind: 'student' });
  const seen = new Set<string>();
  const uniq = recipients.filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)));
  await notify({ event: 'task_published', to: uniq, vars: { type: task.type, title: task.title, subject: subject?.name ?? '', due: task.dueAt ? formatDate(task.dueAt) : 'no date' }, link: schoolLink(school.slug, '/portal') });
}

export async function closeTask(id: string) {
  const task: any = await assertOwnTask(id);
  assertTransition('task', task.status, 'closed', 'This task');
  task.status = 'closed';
  await task.save();
  return task;
}

/** Extend: a closed task can be published again, optionally with a new due date. */
export async function extendTask(id: string, dueAt?: string) {
  const task: any = await assertOwnTask(id);
  assertTransition('task', task.status, 'published', 'This task');
  await assertTermOpen(task.termId);
  task.status = 'published';
  if (dueAt) task.dueAt = new Date(dueAt);
  await task.save();
  return task;
}

// ------------------------------------------------------------------ the class list and marking

export async function taskSubmissions(id: string) {
  const task: any = await assertOwnTask(id, false);
  const term: any = await Term.findById(task.termId).lean();
  const students = await subjectRoster(String(task.classArmId), String(task.subjectId), String(task.termId), term.sessionId);
  const subs: any[] = await Submission.find({ taskId: id }).lean();
  const byStudent = new Map<string, any>(subs.map((s) => [String(s.studentId), s]));
  return {
    task: taskView(task),
    rows: students.map((s) => {
      const sub = byStudent.get(String(s._id));
      return { studentId: String(s._id), name: fullName(s), admissionNumber: s.admissionNumber, photoUrl: photoUrl(s.photo), submissionId: sub ? String(sub._id) : undefined, state: sub ? sub.status : 'not_submitted', isLate: !!sub?.isLate, score: sub?.score, feedback: sub?.feedback, text: sub?.text, files: sub?.files ?? [], submittedAt: sub?.submittedAt, submittedByRole: sub?.submittedByRole, pushed: !!sub?.pushed };
    })
  };
}

export const taskView = (t: any) => ({
  id: String(t._id),
  termId: String(t.termId),
  classArmId: String(t.classArmId),
  subjectId: String(t.subjectId),
  type: t.type,
  title: t.title,
  instructions: t.instructions,
  attachments: t.attachments,
  dueAt: t.dueAt,
  maxScore: t.maxScore,
  lateRule: t.lateRule,
  allowResubmit: t.allowResubmit,
  countsTo: t.countsTo,
  status: t.status,
  paper: !!t.paper,
  publishedAt: t.publishedAt
});

/** Work done on paper: the teacher skips submissions and enters scores against the class list. */
export async function enterPaperScores(id: string, scores: Array<{ studentId: string; score: number | null }>) {
  const c = me();
  const task: any = await assertOwnTask(id);
  await assertTermOpen(task.termId);
  const term: any = await Term.findById(task.termId).lean();
  const roster = new Set((await subjectRoster(String(task.classArmId), String(task.subjectId), String(task.termId), term.sessionId)).map((s) => String(s._id)));
  let saved = 0;
  for (const s of scores) {
    if (!roster.has(s.studentId)) throw validation('A student on the list does not offer this subject in this class.', { scores: 'Not on the class list.' });
    if (s.score !== null && (s.score < 0 || s.score > task.maxScore)) throw validation(`Marked out of ${task.maxScore}.`, { scores: `Scores run from 0 to ${task.maxScore}.` });
    const existing: any = await Submission.findOne({ taskId: id, studentId: s.studentId });
    if (s.score === null) {
      if (existing && !existing.files?.length && !existing.text) await Submission.deleteOne({ _id: existing._id });
      continue;
    }
    if (existing?.pushed) throw stateConflict('A score already pushed to the score sheet cannot be changed here. Edit it on the sheet.');
    if (existing) {
      existing.score = s.score;
      existing.status = 'marked';
      existing.markedBy = c.userId;
      existing.markedAt = new Date();
      await existing.save();
    } else {
      await Submission.create({ taskId: id, studentId: s.studentId, status: 'marked', score: s.score, markedBy: c.userId, markedAt: new Date(), submittedAt: new Date() });
    }
    saved += 1;
  }
  return { saved };
}

export async function markSubmission(id: string, input: { score: number; feedback?: string }) {
  const c = me();
  const sub: any = await need(Submission.findById(id), 'Submission');
  const task: any = await assertOwnTask(String(sub.taskId));
  await assertTermOpen(task.termId);
  if (input.score < 0 || input.score > task.maxScore) throw validation(`Marked out of ${task.maxScore}.`, { score: `Scores run from 0 to ${task.maxScore}.` });
  if (sub.status !== 'marked') assertTransition('submission', sub.status, 'marked', 'This work');
  else if (sub.pushed) throw stateConflict('This score was already pushed to the score sheet. Edit it on the sheet.');
  sub.status = 'marked';
  sub.score = input.score;
  sub.feedback = input.feedback;
  sub.markedBy = c.userId;
  sub.markedAt = new Date();
  await sub.save();
  await notifyWork(sub, task, `${input.score}/${task.maxScore}`, input.feedback ?? '');
  return sub;
}

export async function returnSubmission(id: string, note: string) {
  const sub: any = await need(Submission.findById(id), 'Submission');
  const task: any = await assertOwnTask(String(sub.taskId));
  await assertTermOpen(task.termId);
  assertTransition('submission', sub.status, 'returned', 'This work');
  if (sub.pushed) throw stateConflict('This score was already pushed to the score sheet, so the work cannot be returned.');
  sub.status = 'returned';
  sub.returnNote = note;
  await sub.save();
  await notifyWork(sub, task, 'returned for correction', note);
  return sub;
}

async function notifyWork(sub: any, task: any, score: string, feedback: string) {
  const student: any = await Student.findById(sub.studentId).select('userId').lean();
  const links: any[] = await StudentGuardian.find({ studentId: sub.studentId, access: { $ne: 'none' } }).lean();
  const guardians: any[] = await Guardian.find({ _id: { $in: links.map((l) => l.guardianId) } }).select('userId').lean();
  const to = [...(student?.userId ? [{ userId: String(student.userId), kind: 'student' as const }] : []), ...guardians.filter((g) => g.userId).map((g) => ({ userId: String(g.userId), kind: 'parent' as const }))];
  if (to.length) await notify({ event: 'work_marked', to, vars: { title: task.title, score, feedback } });
}

// ------------------------------------------------------------------ pushing scores to the score sheet

/**
 * Combine chosen tasks into an assessment component on the score sheet. Sum: the total of the scores out of the total of the
 * maximums, scaled to the component. Average: the mean percentage, scaled to the component. Pushed scores can still be edited on
 * the sheet until the sheet is submitted.
 */
export async function pushScores(input: { termId?: string; classArmId: string; subjectId: string; componentKey: string; taskIds: string[]; method: 'sum' | 'average' }) {
  const c = me();
  await assertTeaches(input.classArmId, input.subjectId);
  const term = await resolveTerm(input.termId);
  await assertTermOpen(term._id);
  const { structure } = await armContext(input.classArmId);
  const comp = structure?.components?.find((x: any) => x.key === input.componentKey);
  if (!comp) throw validation('That is not a component on this class’s score sheet.', { componentKey: 'Choose a component.' });
  const sheet: any = await ScoreSheet.findOne({ termId: term._id, classArmId: input.classArmId, subjectId: input.subjectId }).lean();
  if (sheet?.status === 'submitted') throw stateConflict('The score sheet is already submitted. Ask the class teacher to return it first.');
  const tasks: any[] = await Task.find({ _id: { $in: input.taskIds }, classArmId: input.classArmId, subjectId: input.subjectId, termId: term._id }).lean();
  if (tasks.length !== input.taskIds.length) throw notFound('Task');
  if (tasks.some((t) => t.status === 'draft')) throw validation('Publish a task before its scores can count.', { taskIds: 'A task is still a draft.' });

  const students = await subjectRoster(input.classArmId, input.subjectId, String(term._id), term.sessionId);
  const subs: any[] = await Submission.find({ taskId: { $in: input.taskIds }, studentId: { $in: students.map((s) => s._id) } }).lean();
  const scoreOf = (studentId: string, taskId: string) => subs.find((s) => String(s.studentId) === studentId && String(s.taskId) === taskId && s.status === 'marked')?.score ?? 0;
  const totalMax = tasks.reduce((a, t) => a + t.maxScore, 0);

  const pushed: Array<{ studentId: string; value: number }> = [];
  for (const s of students) {
    const sid = String(s._id);
    let fraction: number;
    if (input.method === 'sum') fraction = totalMax ? tasks.reduce((a, t) => a + scoreOf(sid, String(t._id)), 0) / totalMax : 0;
    else fraction = tasks.reduce((a, t) => a + (t.maxScore ? scoreOf(sid, String(t._id)) / t.maxScore : 0), 0) / tasks.length;
    const value = round1(Math.min(comp.max, fraction * comp.max));
    await Score.updateOne(
      { termId: term._id, subjectId: input.subjectId, studentId: sid },
      { $set: { [`components.${comp.key}`]: value, classArmId: input.classArmId, enteredBy: c.userId }, $pull: { absent: comp.key }, $setOnInsert: { source: 'entered' } },
      { upsert: true }
    );
    pushed.push({ studentId: sid, value });
  }
  await Submission.updateMany({ taskId: { $in: input.taskIds }, status: 'marked' }, { pushed: true });
  await ScoreSheet.updateOne({ termId: term._id, classArmId: input.classArmId, subjectId: input.subjectId }, { $setOnInsert: { termId: term._id, classArmId: input.classArmId, subjectId: input.subjectId, staffId: c.staffId, status: 'draft' } }, { upsert: true });
  await audit({ action: 'tasks.push_scores', entityType: 'scoreSheet', entityId: `${input.classArmId}:${input.subjectId}`, after: { component: comp.key, method: input.method, tasks: input.taskIds.length, students: pushed.length } });
  return { component: comp.key, max: comp.max, method: input.method, pushed };
}

// ------------------------------------------------------------------ student and parent side

async function actingStudent(studentId?: string): Promise<{ id: string; byParent: boolean }> {
  const c = me();
  if (c.roles.includes('student') && c.studentId) {
    if (studentId && studentId !== c.studentId) throw notFound('Student');
    return { id: c.studentId, byParent: false };
  }
  if (c.roles.includes('parent')) {
    const kids = await myChildIds();
    const sid = studentId ?? (kids.length === 1 ? kids[0] : undefined);
    if (!sid) throw validation('Choose which child.', { studentId: 'Required for a parent with more than one child.' });
    if (!kids.includes(sid)) throw notFound('Student');
    return { id: sid, byParent: true };
  }
  throw forbidden();
}

async function studentArmAndSubjects(studentId: string) {
  const session = await currentSession();
  const term = await Term.findOne({ status: 'current' }).lean();
  if (!session || !term) return null;
  const e: any = await Enrolment.findOne({ studentId, sessionId: session._id }).lean();
  return e ? { session, term: term as any, armId: String(e.classArmId), levelId: String(e.classLevelId) } : null;
}

async function offersSubject(studentId: string, armId: string, subjectId: string, termId: string, sessionId: unknown) {
  const roster = await subjectRoster(armId, subjectId, termId, sessionId);
  return roster.some((s) => String(s._id) === studentId);
}

export async function myTasks(studentIdParam?: string, state?: 'due' | 'submitted' | 'marked') {
  const who = await actingStudent(studentIdParam);
  const ctx = await studentArmAndSubjects(who.id);
  if (!ctx) return [];
  const tasks: any[] = await Task.find({ termId: ctx.term._id, classArmId: ctx.armId, status: { $in: ['published', 'closed'] } }).sort({ dueAt: 1, createdAt: -1 }).lean();
  const subs: any[] = await Submission.find({ studentId: who.id, taskId: { $in: tasks.map((t) => t._id) } }).lean();
  const byTask = new Map<string, any>(subs.map((s) => [String(s.taskId), s]));
  const subjects = new Map<string, any>((await Subject.find({ _id: { $in: tasks.map((t) => t.subjectId) } }).select('name').lean()).map((s: any) => [String(s._id), s]));
  const out: any[] = [];
  for (const t of tasks) {
    if (!(await offersSubject(who.id, ctx.armId, String(t.subjectId), String(ctx.term._id), ctx.session._id))) continue; // only students who offer the subject see the task
    const sub = byTask.get(String(t._id));
    const stateOf = !sub ? 'due' : sub.status === 'marked' ? 'marked' : sub.status === 'returned' ? 'returned' : 'submitted';
    out.push({ ...taskView(t), subject: subjects.get(String(t.subjectId))?.name, state: stateOf, overdue: !sub && !!t.dueAt && new Date(t.dueAt) < new Date(), submission: sub ? { id: String(sub._id), status: sub.status, score: sub.status === 'marked' ? sub.score : undefined, feedback: sub.status === 'marked' ? sub.feedback : sub.status === 'returned' ? sub.returnNote : undefined, isLate: sub.isLate, submittedAt: sub.submittedAt, submittedByRole: sub.submittedByRole } : null });
  }
  if (state === 'due') return out.filter((t) => t.state === 'due' || t.state === 'returned');
  if (state === 'submitted') return out.filter((t) => t.state === 'submitted');
  if (state === 'marked') return out.filter((t) => t.state === 'marked');
  return out;
}

export async function myTask(taskId: string, studentIdParam?: string) {
  const list = await myTasks(studentIdParam);
  const t = list.find((x) => x.id === taskId);
  if (!t) throw notFound('Task');
  const sub = t.submission ? await Submission.findById(t.submission.id).lean() : null;
  return { ...t, submission: sub ? { ...t.submission, text: (sub as any).text, files: (sub as any).files } : null };
}

/** Submit typed answers, a file, or photographs of handwritten work. A parent can do this in child view, and it records who submitted. */
export async function submitWork(taskId: string, input: { studentId?: string; text?: string; files?: string[] }) {
  const c = me();
  const who = await actingStudent(input.studentId);
  const task: any = await need(Task.findById(taskId), 'Task');
  const visible = await myTasks(who.id);
  if (!visible.some((t) => t.id === taskId)) throw notFound('Task');
  if (task.status !== 'published') throw stateConflict('This task is closed.');
  await assertTermOpen(task.termId);
  if (!input.text?.trim() && !input.files?.length) throw validation('Type your answer or add a file or photograph.', { text: 'Add an answer or a file.' });

  const now = new Date();
  const late = !!task.dueAt && now > new Date(task.dueAt);
  if (late && task.lateRule === 'close') throw stateConflict('This task closed at its due time, so it cannot be submitted now.');
  const files = input.files?.length ? await confirmMany(input.files, 'submission_file') : [];

  const existing: any = await Submission.findOne({ taskId, studentId: who.id });
  const role = who.byParent ? 'parent' : 'student';
  if (existing) {
    const resubmittable = existing.status === 'returned' || (task.allowResubmit && existing.status !== 'marked') || (task.allowResubmit && existing.status === 'marked' && !existing.pushed);
    if (!resubmittable) throw stateConflict('This work was already submitted.');
    if (existing.status === 'marked') assertTransition('submission', 'marked', 'returned');
    existing.text = input.text;
    existing.files = fileObjs(files);
    existing.status = 'submitted';
    existing.submittedAt = now;
    existing.isLate = late && task.lateRule === 'allow_flag';
    existing.submittedBy = c.userId;
    existing.submittedByRole = role;
    existing.score = undefined;
    existing.returnNote = undefined;
    await existing.save();
    return existing;
  }
  return Submission.create({ taskId, studentId: who.id, text: input.text, files: fileObjs(files), status: 'submitted', submittedAt: now, isLate: late && task.lateRule === 'allow_flag', submittedBy: c.userId, submittedByRole: role });
}

export { ClassArm, classNames, armStudents, getCtx, can };
