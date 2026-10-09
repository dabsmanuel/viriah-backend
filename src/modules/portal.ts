import { createRoutes } from '../core/route';
import { z, objectId, dateStr, idParam } from '../core/validate';
import { accepted, ok } from '../core/http';
import { me } from '../core/http';
import { notFound } from '../core/errors';
import { exportRows } from '../core/pagination';
import { platformMetrics } from '../services/schools';
import * as dash from '../services/dashboard';
import * as rep from '../services/reports';
import * as exp from '../services/exports';
import { myChildIds } from '../services/reach';
import { myTasks } from '../services/tasks';
import { getCtx } from '../core/context';

const r = createRoutes();
export const router = r.router;

// ------------------------------------------------------------------ dashboards and portal data

r.get('/dashboard', { access: { perm: 'dashboard.view' }, inactiveOk: true, allowNoMembership: false, summary: 'The home screen data for the caller’s current role' }, async () => {
  if (me().kind === 'platform') return ok(await platformMetrics());
  return ok(await dash.dashboard());
});

r.get('/my/children', { access: { perm: 'fees.own.view' }, summary: 'The caller’s linked children with class and photograph' }, async () => ok(await dash.myChildren()));

r.get('/my/children/:studentId/overview', { access: { perm: 'fees.own.view' }, params: z.object({ studentId: objectId }).strict(), summary: 'Fee balance, latest result, work due, attendance this term' }, async (req) => {
  if (!(await myChildIds()).includes(req.params.studentId as string)) throw notFound('Student');
  const p = await dash.parentDashboard();
  const card = p.children.find((c: any) => c.studentId === req.params.studentId);
  return ok({ ...card, subjects: await dash.subjectsWithTeachers(req.params.studentId as string), work: (await myTasks(req.params.studentId as string)).slice(0, 10) });
});

r.get('/my/overview', { access: { perm: 'tasks.submit' }, summary: 'The student’s own home data' }, async () => {
  const c = me();
  if (!c.studentId) throw notFound('Student');
  return ok(await dash.studentOverview(c.studentId));
});

r.get('/my/subjects', { access: { perm: 'tasks.submit' }, query: z.object({ studentId: objectId.optional() }).strict(), summary: 'Subjects this term with the teacher of each. A parent passes studentId' }, async (req) => {
  const c = me();
  const sid = c.roles.includes('student') ? c.studentId : (req.query as any).studentId;
  if (!sid) throw notFound('Student');
  if (c.roles.includes('parent') && !(await myChildIds()).includes(sid)) throw notFound('Student');
  return ok(await dash.subjectsWithTeachers(sid));
});

// ------------------------------------------------------------------ reports (RPT-01, RPT-02)

const fmt = z.enum(['xlsx', 'csv']).optional();

r.get('/reports/enrolment', { access: { perm: 'reports.enrolment.view' }, query: z.object({ format: fmt }).strict(), summary: 'Enrolment by class and gender' }, async (req) => {
  const out = await rep.enrolmentReport();
  if ((req.query as any).format) return ok(await exportRows('enrolment', [{ header: 'Class', value: (x: any) => x.class }, { header: 'Male', value: (x: any) => x.male }, { header: 'Female', value: (x: any) => x.female }, { header: 'Total', value: (x: any) => x.total }], out.rows, (req.query as any).format));
  return ok(out);
});

r.get('/reports/admissions', { access: { perm: 'reports.enrolment.view' }, query: z.object({ format: fmt }).strict(), summary: 'Applications by status and class' }, async (req) => {
  const out = await rep.admissionsReport();
  if ((req.query as any).format) return ok(await exportRows('admissions', [{ header: 'Class', value: (x: any) => x.class }, { header: 'Total', value: (x: any) => x.total }, ...['submitted', 'under_review', 'assessment_scheduled', 'offered', 'accepted', 'enrolled', 'waitlisted', 'rejected', 'withdrawn', 'expired'].map((s) => ({ header: s.replace(/_/g, ' '), value: (x: any) => x[s] ?? 0 }))], out.byClass, (req.query as any).format));
  return ok(out);
});

r.get('/reports/attendance', { access: { perm: 'reports.attendance.view' }, query: z.object({ from: dateStr.optional(), to: dateStr.optional(), format: fmt }).strict(), summary: 'Attendance rates by class and period' }, async (req) => {
  const q = req.query as any;
  const out = await rep.attendanceReport(q.from, q.to);
  if (q.format) return ok(await exportRows('attendance', [{ header: 'Class', value: (x: any) => x.class }, { header: 'Days opened', value: (x: any) => x.daysOpened }, { header: 'Present marks', value: (x: any) => x.present }, { header: 'Absent marks', value: (x: any) => x.absent }, { header: 'Attendance percent', value: (x: any) => (x.percent === null ? '' : Math.round(x.percent * 100) / 100) }], out.rows, q.format));
  return ok(out);
});

r.get('/reports/academic', { access: { perm: 'reports.academic.view' }, query: z.object({ classArmId: objectId.optional(), termId: objectId.optional(), format: fmt }).strict(), summary: 'Result summaries by class and subject for a term' }, async (req) => {
  const q = req.query as any;
  const out = await rep.academicReport(q.classArmId, q.termId);
  if (q.format) {
    const flat = out.classes.flatMap((c: any) => c.subjects.map((s: any) => ({ class: c.class, ...s })));
    return ok(await exportRows('academic', [{ header: 'Class', value: (x: any) => x.class }, { header: 'Subject', value: (x: any) => x.subject }, { header: 'Students', value: (x: any) => x.students }, { header: 'Average', value: (x: any) => Math.round(x.average * 100) / 100 }, { header: 'Highest', value: (x: any) => x.highest }, { header: 'Lowest', value: (x: any) => x.lowest }, { header: 'Passed', value: (x: any) => x.passed }], flat, q.format));
  }
  return ok(out);
});

r.get('/reports/finance', { access: { perm: 'reports.finance.view' }, query: z.object({ termId: objectId.optional(), format: fmt }).strict(), summary: 'Expected, collected and outstanding by term and class' }, async (req) => {
  const q = req.query as any;
  const out = await rep.financeReport(q.termId);
  if (q.format) return ok(await exportRows('finance', [{ header: 'Class', value: (x: any) => x.class }, { header: 'Expected (kobo)', value: (x: any) => x.expectedKobo }, { header: 'Collected (kobo)', value: (x: any) => x.collectedKobo }, { header: 'Outstanding (kobo)', value: (x: any) => x.outstandingKobo }], out.rows, q.format));
  return ok(out);
});

// ------------------------------------------------------------------ data export (RPT-03)

r.post('/school/exports', { access: { perm: 'school.export.request' }, fresh: true, inactiveOk: true, summary: 'Request a full data export' }, async () => {
  const out = await exp.requestExport();
  return accepted(out.jobId, { exportId: out.exportId });
});

r.get('/school/exports/:id', { access: { perm: 'school.export.request' }, inactiveOk: true, params: idParam, summary: 'Export status and file link' }, async (req) => ok(await exp.exportStatus(req.params.id as string)));

export { getCtx };
