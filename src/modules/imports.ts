import { createRoutes } from '../core/route';
import { z, objectId, text, idParam } from '../core/validate';
import { accepted, created, ok } from '../core/http';
import { audit } from '../core/audit';
import { Student } from '../models';
import { need } from '../services/common';
import * as imp from '../services/imports';

const r = createRoutes();
export const router = r.router;

const MANAGE = { perm: 'imports.manage' } as const;
const kind = z.enum(['students', 'staff', 'past_results', 'opening_balances', 'scores']);

r.get('/imports/templates/:kind', { access: MANAGE, params: z.object({ kind }).strict(), query: z.object({ classArmId: objectId.optional(), subjectId: objectId.optional() }).strict(), summary: 'Download the spreadsheet template' }, async (req) => ok(await imp.template(req.params.kind as imp.Kind, req.query as any)));

r.post(
  '/imports',
  {
    access: MANAGE,
    body: z.object({
      kind: z.enum(['students', 'staff', 'past_results', 'opening_balances']),
      fileRef: z.string().min(10).max(300),
      options: z.object({ sessionName: z.string().regex(/^\d{4}\/\d{4}$/).optional(), termNumber: z.number().int().min(1).max(3).optional(), classArmId: objectId.optional(), mode: z.enum(['totals', 'components']).optional() }).strict().optional()
    }).strict(),
    summary: 'Upload a filled template. Starts validation'
  },
  async (req) => created(await imp.startImport(req.body))
);

r.get('/imports', { access: MANAGE, summary: 'List import batches' }, async () => ok(await imp.listBatches()));

r.get('/imports/:id', { access: MANAGE, params: idParam, query: z.object({ tab: z.enum(['ready', 'errors', 'duplicates']).optional() }).strict(), summary: 'Batch status with the row-by-row validation report' }, async (req) => ok(await imp.batchReport(req.params.id as string, (req.query as any).tab)));

r.patch(
  '/imports/:id/rows/:n',
  { access: MANAGE, params: z.object({ id: objectId, n: z.coerce.number().int().min(2) }).strict(), body: z.object({ cells: z.record(z.string().max(60), z.string().max(300)).optional(), accept: z.boolean().optional() }).strict(), summary: 'Correct one row on screen and revalidate it, or accept a possible duplicate' },
  async (req) => ok(await imp.fixRow(req.params.id as string, Number(req.params.n), req.body.cells ?? {}, req.body.accept))
);

r.post('/imports/:id/commit', { access: MANAGE, idem: true, params: idParam, summary: 'Save all valid rows as one batch' }, async (req) => accepted(await imp.startCommit(req.params.id as string)));

r.post('/imports/:id/rollback', { access: { perm: 'imports.rollback' }, params: idParam, summary: 'Undo the batch if the rules allow it' }, async (req) => {
  const b = await imp.rollback(req.params.id as string);
  return ok({ id: String(b._id), status: b.status });
});

// ------------------------------------------------------------------ past results on screen

r.get('/legacy/results', { access: { perm: 'legacy.results.manage' }, query: z.object({ studentId: objectId }).strict(), summary: 'Imported past results for a student' }, async (req) => {
  await need(Student.findById((req.query as any).studentId).select('_id').lean(), 'Student');
  return ok(await imp.legacyResults((req.query as any).studentId));
});

r.put(
  '/legacy/results',
  {
    access: { perm: 'legacy.results.manage' },
    idem: true,
    body: z.object({
      sessionName: z.string().regex(/^\d{4}\/\d{4}$/, 'Write the session as two years, like 2024/2025.'),
      termNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      classArmId: objectId,
      mode: z.enum(['totals', 'components']),
      rows: z.array(z.object({ studentId: objectId, subjectId: objectId, total: z.number().min(0).max(100).optional(), components: z.record(z.string().max(20), z.number().min(0).max(100)).optional() }).strict()).min(1).max(2000)
    }).strict(),
    summary: 'Enter past results on screen for a past session, term and class'
  },
  async (req) => {
    const out = await imp.writeLegacy(req.body);
    await audit({ action: 'legacy.results.write', entityType: 'session', entityId: req.body.sessionName, after: { rows: req.body.rows.length, term: req.body.termNumber } });
    return ok({ scores: out.scoreIds.length, students: out.termResultIds.length, skipped: out.failed });
  }
);

export { text };
