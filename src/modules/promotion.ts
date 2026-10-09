import { createRoutes } from '../core/route';
import { z, objectId, text, idParam } from '../core/validate';
import { accepted, ok } from '../core/http';
import { forbidden } from '../core/errors';
import { me } from '../core/http';
import * as promo from '../services/promotion';

const r = createRoutes();
export const router = r.router;

const level = z.object({ levelId: objectId }).strict();
const arm = z.object({ armId: objectId }).strict();
const sessionQ = z.object({ sessionId: objectId.optional() }).strict();
const pct = z.number().min(0).max(100).nullable().optional();

r.get('/promotion/rules', { access: { perm: 'promotion.rules.view' }, summary: 'Active rules for every class level' }, async () => ok(await promo.rulesOverview()));

r.put(
  '/promotion/rules/:levelId',
  {
    access: { perm: 'promotion.rules.manage' },
    params: level,
    body: z.object({ minAnnualAverage: pct, mustPassSubjectIds: z.array(objectId).max(20).optional(), minSubjectsPassed: z.number().int().min(0).max(40).nullable().optional(), minAttendancePercent: pct, trial: z.object({ enabled: z.boolean(), minAnnualAverage: pct, maxFailedMustPass: z.number().int().min(0).max(10).optional() }).strict().optional() }).strict(),
    summary: 'Save rules for a level. Creates a new version'
  },
  async (req) => {
    const rule = await promo.saveRule(req.params.levelId as string, req.body);
    return ok({ id: String(rule._id), version: rule.version });
  }
);

r.get('/promotion/rules/:levelId/versions', { access: { perm: 'promotion.rules.manage' }, params: level, summary: 'Past versions' }, async (req) => ok(await promo.ruleVersions(req.params.levelId as string)));

r.get('/promotion/lists', { access: { perm: 'promotion.rules.view' }, query: sessionQ, summary: 'Status of each class arm list for a session' }, async (req) => ok(await promo.listsOverview((req.query as any).sessionId)));

r.get('/promotion/lists/:armId', { access: { perm: 'promotion.rules.view' }, params: arm, query: sessionQ, summary: 'The list: each student proposal, checks and final outcome' }, async (req) => ok(await promo.listView(req.params.armId as string, (req.query as any).sessionId)));

r.post('/promotion/lists/:armId/propose', { access: { perm: 'promotion.review' }, params: arm, query: sessionQ, summary: 'Run the rules again, for example after a result was revised' }, async (req) => accepted(await promo.proposeNow(req.params.armId as string, (req.query as any).sessionId)));

r.patch('/promotion/decisions/:id', { access: { perm: 'promotion.review' }, params: idParam, body: z.object({ outcome: z.enum(['promoted', 'promoted_on_trial', 'repeat', 'graduated']), reason: text(500).min(3, 'A reason is required.') }).strict(), summary: 'Set the final outcome with a reason' }, async (req) => {
  const d = await promo.setFinalOutcome(req.params.id as string, req.body.outcome, req.body.reason);
  return ok({ id: String(d._id), final: { outcome: d.final.outcome, by: String(d.final.by) } });
});

r.post('/promotion/lists/:armId/submit', { access: { perm: 'promotion.review' }, params: arm, query: sessionQ, summary: 'The class teacher submits the reviewed list' }, async (req) => ok({ status: (await promo.submitList(req.params.armId as string, (req.query as any).sessionId)).status }));
r.post('/promotion/lists/:armId/approve', { access: { perm: 'promotion.approve' }, params: arm, query: sessionQ, fresh: true, summary: 'Approve the list' }, async (req) => ok({ status: (await promo.approveList(req.params.armId as string, (req.query as any).sessionId)).status }));
r.post('/promotion/lists/:armId/return', { access: { perm: 'promotion.approve' }, params: arm, query: sessionQ, body: z.object({ note: text(500).min(3, 'Tell the class teacher what to fix.') }).strict(), summary: 'Return to the class teacher' }, async (req) => ok({ status: (await promo.returnList(req.params.armId as string, req.body.note, (req.query as any).sessionId)).status }));

r.get('/promotion/rollover/preview', { access: { perm: 'promotion.rollover' }, query: z.object({ fromSessionId: objectId.optional(), toSessionId: objectId.optional(), armMode: z.enum(['keep', 'manual']).default('keep') }).strict(), summary: 'Each student current and next class, and anything blocking rollover' }, async (req) => {
  const q = req.query as any;
  return ok(await promo.rolloverPreview(q.fromSessionId, q.toSessionId, q.armMode));
});

r.post(
  '/promotion/rollover',
  { access: { perm: 'promotion.rollover' }, idem: true, fresh: true, body: z.object({ fromSessionId: objectId.optional(), toSessionId: objectId, armMode: z.enum(['keep', 'manual']).default('keep'), manualArms: z.record(objectId, objectId).optional() }).strict(), summary: 'Run rollover into the new session. Answers 202' },
  async (req) => accepted(await promo.runRollover(req.body))
);

r.post('/promotion/rollover/undo', { access: { perm: 'promotion.rollover' }, fresh: true, summary: 'Undo, if nothing has been recorded in the new session' }, async () => {
  if (!me().roles.includes('owner')) throw forbidden('Only the owner can undo a rollover.');
  return ok(await promo.undoRollover());
});

r.get('/results/students/:id/annual', { access: { perm: 'results.published.view' }, params: idParam, query: sessionQ, summary: 'The annual result for a session' }, async (req) => ok(await promo.annualForStudent(req.params.id as string, (req.query as any).sessionId)));
