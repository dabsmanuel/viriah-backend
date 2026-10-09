import { createRoutes } from '../core/route';
import { z, objectId, pageQuery, email, name, phone, slugSchema, text, dateStr, kobo, idParam } from '../core/validate';
import { accepted, created, list, noContent, ok } from '../core/http';
import { audit } from '../core/audit';
import { notFound } from '../core/errors';
import { exportRows } from '../core/pagination';
import { retryJob } from '../jobs/queue';
import { Job, PlatformSetting, Preset } from '../models';
import { PRESET_KINDS } from '../models/platform';
import * as schools from '../services/schools';
import * as auth from '../services/auth';
import { clearSettingsCache, need, platformSettings } from '../services/common';
import { portalLink } from '../lib/links';

const r = createRoutes('/platform');
export const router = r.router;

const SA = { perm: 'platform.schools.manage' } as const;
const reason = z.object({ reason: text(500).min(3, 'Give a reason.') }).strict();

// ------------------------------------------------------------------ schools

const listQuery = z.object({ ...pageQuery, status: z.enum(['pending', 'active', 'suspended', 'rejected', 'closed']).optional(), state: text(60).optional(), type: z.enum(['nursery', 'primary', 'secondary']).optional() }).strict();

r.get('/schools', { access: SA, query: listQuery, summary: 'List schools with filters and counts' }, async (req) => {
  const q = req.query as any;
  const { rows, meta } = await schools.listSchools(q);
  if (q.format) {
    return ok(
      await exportRows(
        'schools',
        [
          { header: 'School', value: (s: any) => s.name },
          { header: 'Address', value: (s: any) => s.slug },
          { header: 'Status', value: (s: any) => s.status },
          { header: 'State', value: (s: any) => s.state },
          { header: 'Students', value: (s: any) => s.students },
          { header: 'Staff', value: (s: any) => s.staff },
          { header: 'Fees collected (kobo)', value: (s: any) => s.feesCollectedKobo }
        ],
        rows,
        q.format
      )
    );
  }
  return ok(rows, meta);
});

const addressSchema = z.object({ street: text(200).optional(), town: text(80).optional(), lga: name(80), state: name(60) }).strict();
const ownerSchema = z.object({ firstName: name(), lastName: name(), phone, email: email.optional() }).strict();

r.post(
  '/schools',
  {
    access: SA,
    body: z.object({
      name: name(120),
      slug: slugSchema,
      types: z.array(z.enum(['nursery', 'primary', 'secondary'])).min(1),
      address: addressSchema,
      owner: ownerSchema,
      plan: z.object({ name: text(40).optional(), status: z.enum(['trial', 'active', 'past_due', 'cancelled']).optional() }).strict().optional(),
      commission: z.object({ type: z.enum(['none', 'flat', 'percent']), value: z.number().nonnegative() }).strict().optional()
    }).strict(),
    summary: 'Create a school on an owner’s behalf and send the invite'
  },
  async (req) => created(await schools.createAssistedSchool(req.body))
);

r.get('/schools/:id', { access: SA, params: idParam, summary: 'One school with setup progress, plan, usage and recent activity' }, async (req) => ok(await schools.schoolDetail(req.params.id as string)));

r.patch(
  '/schools/:id',
  {
    access: SA,
    params: idParam,
    body: z.object({
      plan: z.object({ name: text(40).optional(), status: z.enum(['trial', 'active', 'past_due', 'cancelled']).optional(), renewsOn: dateStr.optional() }).strict().optional(),
      commission: z.object({ type: z.enum(['none', 'flat', 'percent']), value: z.number().nonnegative() }).strict().optional(),
      notes: text(2000).optional()
    }).strict(),
    summary: 'Edit plan, commission and platform notes'
  },
  async (req) => {
    await schools.updateSchoolPlatformFields(req.params.id as string, req.body);
    return ok(await schools.schoolDetail(req.params.id as string));
  }
);

r.post('/schools/:id/approve', { access: SA, params: idParam, summary: 'Approve a pending school' }, async (req) => {
  await schools.approveSchool(req.params.id as string);
  return ok({ status: 'active' });
});
r.post('/schools/:id/reject', { access: SA, params: idParam, body: reason, summary: 'Reject with a reason' }, async (req) => {
  await schools.rejectSchool(req.params.id as string, req.body.reason);
  return ok({ status: 'rejected' });
});
r.post('/schools/:id/suspend', { access: SA, params: idParam, body: reason, summary: 'Suspend with a reason' }, async (req) => {
  await schools.suspendSchool(req.params.id as string, req.body.reason);
  return ok({ status: 'suspended' });
});
r.post('/schools/:id/reactivate', { access: SA, params: idParam, summary: 'Lift a suspension' }, async (req) => {
  await schools.reactivateSchool(req.params.id as string);
  return ok({ status: 'active' });
});
r.post(
  '/schools/:id/transfer-ownership',
  { access: SA, params: idParam, fresh: true, body: z.object({ newOwnerUserId: objectId, reason: text(500).min(3) }).strict(), summary: 'Move ownership to another verified user' },
  async (req) => ok(await schools.transferOwnership(req.params.id as string, req.body.newOwnerUserId, req.body.reason))
);

// ------------------------------------------------------------------ support access

r.post('/schools/:id/support-session', { access: { perm: 'platform.support.access' }, params: idParam, body: reason, summary: 'Start a support session with a reason. Returns a support token' }, async (req) => {
  const out = await auth.startSupportSession(req.params.id as string, req.body.reason, req);
  return created({ ...out, portalUrl: portalLink(out.school.slug, `/support?token=${encodeURIComponent(out.supportToken)}`) });
});
r.delete('/support-session', { access: { perm: 'platform.support.access' }, summary: 'End the support session' }, async () => {
  await auth.endSupportSession();
  return noContent();
});

// ------------------------------------------------------------------ metrics, payments, audit, settings

r.get('/metrics', { access: { perm: 'platform.metrics.view' }, summary: 'Platform dashboard figures' }, async () => ok(await schools.platformMetrics()));

r.get(
  '/payments',
  { access: { perm: 'platform.payments.view' }, query: z.object({ page: pageQuery.page, limit: pageQuery.limit, status: text(30).optional(), schoolId: objectId.optional(), from: dateStr.optional(), to: dateStr.optional() }).strict(), summary: 'Payments across schools with commission' },
  async (req) => {
    const out = await schools.platformPayments(req.query as any);
    return list(out.rows, out.meta, { totals: out.totals });
  }
);

r.get(
  '/audit-logs',
  { access: { perm: 'platform.audit.view' }, query: z.object({ page: pageQuery.page, limit: pageQuery.limit, schoolId: objectId.optional(), userId: objectId.optional(), action: text(80).optional(), from: dateStr.optional(), to: dateStr.optional() }).strict(), summary: 'Search the audit log across schools' },
  async (req) => {
    const out = await schools.platformAuditLogs(req.query as any);
    return ok(out.rows, out.meta);
  }
);

r.get('/settings', { access: { perm: 'platform.settings.manage' }, summary: 'Read platform settings' }, async () => ok(await platformSettings()));

r.put(
  '/settings',
  {
    access: { perm: 'platform.settings.manage' },
    body: z.object({
      defaultCommission: z.object({ type: z.enum(['none', 'flat', 'percent']), value: z.number().nonnegative() }).strict().optional(),
      paymentRates: z.object({ percent: z.number().min(0).max(10), flatKobo: kobo, flatWaivedBelowKobo: kobo, capKobo: kobo }).strict().optional(),
      smsUnitPriceKobo: kobo.optional(),
      reservedSlugs: z.array(slugSchema).max(500).optional(),
      legalTexts: z.object({ terms: text(20000).optional(), privacy: text(20000).optional(), dpa: text(20000).optional(), consent: text(2000).optional(), refundPolicy: text(20000).optional(), contentRules: text(20000).optional() }).strict().optional()
    }).strict(),
    summary: 'Update default commission, payment rates, SMS price, reserved names, legal texts'
  },
  async (req) => {
    const before = await platformSettings();
    await PlatformSetting.updateOne({ key: 'platform' }, { $set: req.body }, { upsert: true });
    clearSettingsCache();
    await audit({ action: 'platform.settings.update', entityType: 'platformSettings', before: { defaultCommission: before.defaultCommission, paymentRates: before.paymentRates, smsUnitPriceKobo: before.smsUnitPriceKobo }, after: req.body });
    return ok(await platformSettings());
  }
);

// ------------------------------------------------------------------ presets

const presetBody = z.object({ kind: z.enum(PRESET_KINDS), name: name(160), data: z.record(z.string(), z.any()), active: z.boolean().default(true), order: z.number().int().default(0) }).strict();

r.get('/presets', { access: { perm: 'platform.presets.manage' }, query: z.object({ kind: z.enum(PRESET_KINDS).optional() }).strict(), summary: 'List presets by kind' }, async (req) => {
  const q = req.query as { kind?: string };
  return ok(await Preset.find(q.kind ? { kind: q.kind } : {}).sort({ kind: 1, order: 1, name: 1 }).lean());
});
r.post('/presets', { access: { perm: 'platform.presets.manage' }, body: presetBody, summary: 'Create a preset' }, async (req) => {
  const doc = await Preset.create(req.body);
  await audit({ action: 'platform.preset.create', entityType: 'preset', entityId: doc._id, after: { kind: doc.kind, name: doc.name } });
  return created(doc);
});
r.patch('/presets/:id', { access: { perm: 'platform.presets.manage' }, params: idParam, body: presetBody.partial().strict(), summary: 'Edit a preset' }, async (req) => {
  const doc = await need(Preset.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }), 'Preset');
  await audit({ action: 'platform.preset.update', entityType: 'preset', entityId: doc._id, after: req.body });
  return ok(doc);
});
r.delete('/presets/:id', { access: { perm: 'platform.presets.manage' }, params: idParam, summary: 'Remove a preset' }, async (req) => {
  const doc = await Preset.findByIdAndDelete(req.params.id);
  if (!doc) throw notFound('Preset');
  await audit({ action: 'platform.preset.delete', entityType: 'preset', entityId: doc._id, before: { kind: doc.kind, name: doc.name } });
  return noContent();
});

// ------------------------------------------------------------------ jobs

r.get('/jobs/failed', { access: { perm: 'platform.jobs.manage' }, summary: 'Failed background jobs' }, async () => {
  const rows = await Job.find({ status: 'failed' }).sort({ finishedAt: -1 }).limit(100).lean();
  return ok(rows.map((j: any) => ({ id: String(j._id), kind: j.kind, schoolId: j.schoolId ? String(j.schoolId) : undefined, error: j.error, attempts: j.attempts, finishedAt: j.finishedAt })));
});
r.post('/jobs/:id/retry', { access: { perm: 'platform.jobs.manage' }, params: idParam, summary: 'Retry a failed job' }, async (req) => {
  const job = await need(Job.findById(req.params.id).lean(), 'Job');
  await retryJob(String(job._id));
  await audit({ action: 'platform.job.retry', entityType: 'job', entityId: job._id, after: { kind: job.kind } });
  return accepted(String(job._id));
});

