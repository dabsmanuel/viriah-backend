import { createRoutes } from '../core/route';
import { z, objectId, name, text, dateStr, pageQuery, idParam } from '../core/validate';
import { created, list, noContent, ok } from '../core/http';
import { paging } from '../core/pagination';
import { Task } from '../models';
import * as tasks from '../services/tasks';

const r = createRoutes();
export const router = r.router;

const MANAGE = { perm: 'tasks.manage' } as const;
const VIEW = { perm: ['tasks.view', 'tasks.manage'] as ('tasks.view' | 'tasks.manage')[] };

const taskBody = z.object({
  termId: objectId.optional(),
  classArmId: objectId,
  subjectId: objectId,
  type: z.enum(['assignment', 'homework', 'project', 'test']),
  title: name(160),
  instructions: text(4000).optional(),
  attachments: z.array(z.string().min(10).max(300)).max(5).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  maxScore: z.number().positive().max(1000).default(10),
  lateRule: z.enum(['allow', 'allow_flag', 'close']).default('allow_flag'),
  allowResubmit: z.boolean().default(true),
  countsTo: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/).optional(),
  paper: z.boolean().optional()
}).strict();

r.get('/tasks', { access: VIEW, query: z.object({ ...pageQuery, classArmId: objectId.optional(), subjectId: objectId.optional(), termId: objectId.optional(), status: z.enum(['draft', 'published', 'closed']).optional() }).strict(), summary: 'The caller’s tasks, filtered by class arm, subject, term and status' }, async (req) => {
  const q = req.query as any;
  const reach = await tasks.visibleTaskFilter();
  const filter: any = { ...reach };
  for (const k of ['classArmId', 'subjectId', 'termId', 'status']) if (q[k]) filter[k] = q[k];
  if (q.q) filter.title = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const p = paging(q, ['createdAt', 'dueAt', 'title'], '-createdAt');
  const [rows, total] = await Promise.all([Task.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), Task.countDocuments(filter)]);
  return list(rows.map(tasks.taskView), { page: p.page, limit: p.limit, total });
});

r.post('/tasks', { access: MANAGE, body: taskBody, summary: 'Create a task as a draft' }, async (req) => created(tasks.taskView(await tasks.createTask(req.body))));

r.get('/tasks/:id', { access: VIEW, params: idParam, summary: 'One task' }, async (req) => ok(tasks.taskView(await tasks.assertOwnTask(req.params.id as string, false))));

r.patch('/tasks/:id', { access: MANAGE, params: idParam, body: taskBody.partial().strict(), summary: 'Edit a task' }, async (req) => ok(tasks.taskView(await tasks.updateTask(req.params.id as string, req.body))));

r.delete('/tasks/:id', { access: MANAGE, params: idParam, summary: 'Delete a draft task' }, async (req) => {
  await tasks.deleteTask(req.params.id as string);
  return noContent();
});

r.post('/tasks/:id/publish', { access: MANAGE, params: idParam, summary: 'Publish and notify' }, async (req) => ok(tasks.taskView(await tasks.publishTask(req.params.id as string))));
r.post('/tasks/:id/close', { access: MANAGE, params: idParam, summary: 'Stop accepting submissions' }, async (req) => ok(tasks.taskView(await tasks.closeTask(req.params.id as string))));
r.post('/tasks/:id/extend', { access: MANAGE, params: idParam, body: z.object({ dueAt: z.string().datetime({ offset: true }).optional() }).strict().optional(), summary: 'Open a closed task again, optionally with a new due date' }, async (req) => ok(tasks.taskView(await tasks.extendTask(req.params.id as string, (req.body as any)?.dueAt))));

r.get('/tasks/:id/submissions', { access: VIEW, params: idParam, summary: 'Class list with each student’s submission state' }, async (req) => ok(await tasks.taskSubmissions(req.params.id as string)));

r.put('/tasks/:id/scores', { access: MANAGE, params: idParam, body: z.object({ scores: z.array(z.object({ studentId: objectId, score: z.number().min(0).nullable() }).strict()).max(200) }).strict(), summary: 'Enter scores for paper work against the class list' }, async (req) => ok(await tasks.enterPaperScores(req.params.id as string, req.body.scores)));

r.post('/submissions/:id/mark', { access: MANAGE, params: idParam, body: z.object({ score: z.number().min(0), feedback: text(1000).optional() }).strict(), summary: 'Score and give feedback' }, async (req) => {
  const s = await tasks.markSubmission(req.params.id as string, req.body);
  return ok({ id: String(s._id), status: s.status, score: s.score });
});
r.post('/submissions/:id/return', { access: MANAGE, params: idParam, body: z.object({ note: text(1000).min(3, 'Tell the student what to correct.') }).strict(), summary: 'Return for correction with a note' }, async (req) => {
  const s = await tasks.returnSubmission(req.params.id as string, req.body.note);
  return ok({ id: String(s._id), status: s.status });
});

r.post(
  '/tasks/push-scores',
  { access: MANAGE, body: z.object({ termId: objectId.optional(), classArmId: objectId, subjectId: objectId, componentKey: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/), taskIds: z.array(objectId).min(1).max(20), method: z.enum(['sum', 'average']) }).strict(), summary: 'Combine chosen tasks into an assessment component on the score sheet' },
  async (req) => ok(await tasks.pushScores(req.body))
);

// ------------------------------------------------------------------ the student and parent side

const studentQuery = z.object({ studentId: objectId.optional(), state: z.enum(['due', 'submitted', 'marked']).optional() }).strict();
r.get('/my/tasks', { access: { perm: 'tasks.submit' }, query: studentQuery, summary: 'Tasks for a student, by state. A parent passes studentId' }, async (req) => {
  const q = req.query as any;
  return ok(await tasks.myTasks(q.studentId, q.state));
});
r.get('/my/tasks/:id', { access: { perm: 'tasks.submit' }, params: idParam, query: z.object({ studentId: objectId.optional() }).strict(), summary: 'One task with the student’s submission' }, async (req) => ok(await tasks.myTask(req.params.id as string, (req.query as any).studentId)));
r.put(
  '/my/tasks/:id/submission',
  { access: { perm: 'tasks.submit' }, params: idParam, body: z.object({ studentId: objectId.optional(), text: text(10000).optional(), files: z.array(z.string().min(10).max(300)).max(5).optional() }).strict(), summary: 'Submit or resubmit' },
  async (req) => {
    const s = await tasks.submitWork(req.params.id as string, req.body);
    return ok({ id: String(s._id), status: s.status, isLate: s.isLate, submittedByRole: s.submittedByRole });
  }
);

export { dateStr };
