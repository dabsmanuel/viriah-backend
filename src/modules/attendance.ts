import { createRoutes } from '../core/route';
import { z, objectId, dateStr, text, idParam } from '../core/validate';
import { created, noContent, ok } from '../core/http';
import { NonSchoolDay } from '../models';
import * as att from '../services/attendance';
import { resolveTerm } from '../services/reach';

const r = createRoutes('/attendance');
export const router = r.router;

const part = z.enum(['day', 'am', 'pm']).optional();
const status = z.enum(['present', 'absent', 'late', 'excused']);

r.get('/registers', { access: { perm: 'attendance.view' }, query: z.object({ classArmId: objectId, date: dateStr, part }).strict(), summary: 'The register for a class arm and date' }, async (req) => {
  const q = req.query as any;
  return ok(await att.getRegister(q.classArmId, q.date, q.part));
});

r.put(
  '/registers',
  { access: { perm: 'attendance.take' }, body: z.object({ classArmId: objectId, date: dateStr, part, entries: z.array(z.object({ studentId: objectId, status }).strict()).max(200) }).strict(), summary: 'Save the register for a class arm and date' },
  async (req) => ok(await att.saveRegister(req.body))
);

r.post('/registers/:id/unlock', { access: { perm: 'attendance.unlock' }, params: idParam, summary: 'Allow a late correction' }, async (req) => {
  const reg = await att.unlockRegister(req.params.id as string);
  return ok({ id: String(reg._id), unlockedUntil: reg.unlockedUntil });
});

r.get('/summary', { access: { perm: 'attendance.view' }, query: z.object({ classArmId: objectId, termId: objectId.optional() }).strict(), summary: 'Totals per student for a class arm and term' }, async (req) => {
  const q = req.query as any;
  return ok(await att.armSummary(q.classArmId, q.termId));
});

r.get('/students/:id', { access: { perm: 'attendance.view' }, params: idParam, query: z.object({ termId: objectId.optional() }).strict(), summary: 'A student’s attendance for a term, day by day' }, async (req) => ok(await att.studentDays(req.params.id as string, (req.query as any).termId)));

r.get('/missing', { access: { perm: 'attendance.unlock' }, query: z.object({ date: dateStr }).strict(), summary: 'Class arms with no register for a date' }, async (req) => ok(await att.missingRegisters((req.query as any).date)));

r.get('/non-school-days', { access: { perm: 'academics.view' }, query: z.object({ termId: objectId.optional() }).strict(), summary: 'Holidays inside the term' }, async (req) => {
  const term = await resolveTerm((req.query as any).termId);
  const rows: any[] = await NonSchoolDay.find({ termId: term._id }).sort({ date: 1 }).lean();
  return ok(rows.map((d) => ({ id: String(d._id), date: d.date, reason: d.reason })));
});

r.post('/non-school-days', { access: { perm: 'attendance.days.manage' }, body: z.object({ termId: objectId.optional(), date: dateStr, reason: text(120).optional() }).strict(), summary: 'Add a holiday' }, async (req) => {
  const d = await att.addNonSchoolDay(req.body);
  return created({ id: String(d._id), date: d.date });
});

r.delete('/non-school-days/:id', { access: { perm: 'attendance.days.manage' }, params: idParam, summary: 'Remove a holiday' }, async (req) => {
  await att.removeNonSchoolDay(req.params.id as string);
  return noContent();
});
