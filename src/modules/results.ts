import { createRoutes } from '../core/route';
import { z, objectId, text, idParam } from '../core/validate';
import { accepted, ok } from '../core/http';
import * as scores from '../services/scores';
import * as results from '../services/results';

const r = createRoutes();
export const router = r.router;

const termQ = z.object({ termId: objectId.optional() }).strict();
const sheetParams = z.object({ armId: objectId, subjectId: objectId }).strict();

// ------------------------------------------------------------------ score sheets

r.get('/score-sheets', { access: { perm: 'scores.view' }, query: z.object({ classArmId: objectId, termId: objectId.optional() }).strict(), summary: 'Status of every subject sheet for a class arm and term' }, async (req) => {
  const q = req.query as any;
  return ok(await scores.sheetsStatus(q.classArmId, q.termId));
});

r.get('/score-sheets/:armId/:subjectId', { access: { perm: 'scores.view' }, params: sheetParams, query: termQ, summary: 'The grid: students, components, scores, flags, status' }, async (req) => ok(await scores.getSheet(req.params.armId as string, req.params.subjectId as string, (req.query as any).termId)));

r.patch(
  '/score-sheets/:armId/:subjectId',
  {
    access: { perm: 'scores.enter' },
    params: sheetParams,
    query: termQ,
    body: z.object({ cells: z.array(z.object({ studentId: objectId, component: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/).optional(), score: z.number().nullable().optional(), absent: z.boolean().optional(), exempt: z.boolean().optional() }).strict()).min(1).max(1000) }).strict(),
    summary: 'Save changed cells. Accepts a partial list so autosave stays small'
  },
  async (req) => ok(await scores.saveCells(req.params.armId as string, req.params.subjectId as string, (req.query as any).termId, req.body.cells))
);

r.post('/score-sheets/:armId/:subjectId/upload', { access: { perm: 'scores.enter' }, params: sheetParams, query: termQ, body: z.object({ fileRef: z.string().min(10).max(300) }).strict(), summary: 'Fill the sheet from the spreadsheet template' }, async (req) =>
  ok(await scores.uploadSheet(req.params.armId as string, req.params.subjectId as string, (req.query as any).termId, req.body.fileRef))
);

r.post('/score-sheets/:armId/:subjectId/submit', { access: { perm: 'scores.submit' }, params: sheetParams, query: termQ, summary: 'Submit the sheet. Fails if any cell is empty and unflagged' }, async (req) => {
  const s = await scores.submitSheet(req.params.armId as string, req.params.subjectId as string, (req.query as any).termId);
  return ok({ status: s.status, submittedAt: s.submittedAt });
});

r.post('/score-sheets/:armId/:subjectId/return', { access: { perm: 'scores.return' }, params: sheetParams, query: termQ, body: z.object({ note: text(500).min(3, 'Tell the teacher what to check.') }).strict(), summary: 'Return the sheet to its teacher with a note' }, async (req) => {
  const s = await scores.returnSheet(req.params.armId as string, req.params.subjectId as string, (req.query as any).termId, req.body.note);
  return ok({ status: s.status });
});

// ------------------------------------------------------------------ class results

const arm = z.object({ armId: objectId }).strict();
const VIEW = { perm: 'results.class.view' } as const;

r.get('/class-results/:armId', { access: VIEW, params: arm, query: termQ, summary: 'The class result: status, students, totals, averages, positions' }, async (req) => ok(await results.classResultView(req.params.armId as string, (req.query as any).termId)));

r.put(
  '/class-results/:armId/ratings',
  { access: { perm: 'results.ratings.manage' }, params: arm, query: termQ, body: z.object({ items: z.array(z.object({ studentId: objectId, ratings: z.array(z.object({ traitId: objectId, value: z.number().int(), remark: text(200).optional() }).strict()).max(40) }).strict()).max(200) }).strict(), summary: 'Save behaviour ratings, or nursery ratings and remarks' },
  async (req) => ok(await results.saveRatings(req.params.armId as string, (req.query as any).termId, req.body.items))
);

r.put(
  '/class-results/:armId/comments',
  { access: { perm: 'results.comments.manage' }, params: arm, query: termQ, body: z.object({ items: z.array(z.object({ studentId: objectId, teacher: text(500).optional(), principal: text(500).optional() }).strict()).max(200) }).strict(), summary: 'Save class teacher or principal comments' },
  async (req) => ok(await results.saveComments(req.params.armId as string, (req.query as any).termId, req.body.items))
);

r.get('/class-results/:armId/comment-suggestions', { access: { perm: 'results.comments.manage' }, params: arm, query: termQ, summary: 'Suggested comments from the comment bank' }, async (req) => ok(await results.commentSuggestions(req.params.armId as string, (req.query as any).termId)));

r.post('/class-results/:armId/compile', { access: { perm: 'results.compile' }, params: arm, query: termQ, summary: 'Run the calculations. Answers 202' }, async (req) => accepted(await results.startCompile(req.params.armId as string, (req.query as any).termId)));

r.post('/class-results/:armId/submit', { access: { perm: 'results.submit' }, params: arm, query: termQ, summary: 'Send for approval' }, async (req) => {
  const cr = await results.submitClassResult(req.params.armId as string, (req.query as any).termId);
  return ok({ status: cr.status });
});

r.post('/class-results/:armId/approve', { access: { perm: 'results.approve' }, params: arm, query: termQ, fresh: true, summary: 'Approve' }, async (req) => {
  const cr = await results.approveClassResult(req.params.armId as string, (req.query as any).termId);
  return ok({ status: cr.status, enteredAndApprovedBySame: cr.enteredAndApprovedBySame });
});

r.post('/class-results/:armId/reject', { access: { perm: 'results.approve' }, params: arm, query: termQ, body: z.object({ note: text(500).min(3, 'Tell the class teacher what to fix.') }).strict(), summary: 'Return to the class teacher with a note' }, async (req) => {
  const cr = await results.rejectClassResult(req.params.armId as string, (req.query as any).termId, req.body.note);
  return ok({ status: cr.status });
});

r.post('/class-results/:armId/publish', { access: { perm: 'results.publish' }, params: arm, query: termQ, fresh: true, summary: 'Publish, generate report cards and notify. Answers 202' }, async (req) => accepted(await results.publishClassResult(req.params.armId as string, (req.query as any).termId)));

r.post('/class-results/:armId/reopen', { access: { perm: 'results.reopen' }, params: arm, query: termQ, fresh: true, body: z.object({ reason: text(500).min(3, 'A reason is required.'), studentIds: z.array(objectId).max(200).optional() }).strict(), summary: 'Reopen for the class or named students, with a reason' }, async (req) => {
  const cr = await results.reopenClassResult(req.params.armId as string, (req.query as any).termId, req.body.reason, req.body.studentIds);
  return ok({ status: cr.status });
});

r.get('/class-results/:armId/broadsheet', { access: { perm: 'results.broadsheet' }, params: arm, query: z.object({ termId: objectId.optional(), format: z.enum(['json', 'xlsx', 'pdf']).default('json') }).strict(), summary: 'The broadsheet as data, Excel or PDF' }, async (req) => {
  const q = req.query as any;
  const out = await results.broadsheet(req.params.armId as string, q.termId, q.format);
  return ok('json' in out ? out.json : out);
});

r.get('/class-results/:armId/report-cards', { access: { perm: 'results.broadsheet' }, params: arm, query: termQ, summary: 'Link to the merged PDF of all report cards' }, async (req) => ok(await results.classCardsLink(req.params.armId as string, (req.query as any).termId)));

// ------------------------------------------------------------------ results for a student

const STU = { perm: 'results.published.view' } as const;
r.get('/results/students/:id', { access: STU, params: idParam, summary: 'A student’s results by term. Honours the fee block for parents and students' }, async (req) => ok(await results.studentResults(req.params.id as string)));
r.get('/results/students/:id/report-card', { access: STU, params: idParam, query: termQ, summary: 'Link to a term’s report card PDF' }, async (req) => ok(await results.reportCardLink(req.params.id as string, (req.query as any).termId)));
r.post('/results/students/:id/unblock', { access: { perm: 'results.unblock' }, params: idParam, body: termQ.optional(), summary: 'Lift the fee block for one student and term' }, async (req) => ok(await results.unblockStudent(req.params.id as string, (req.body as any)?.termId)));
