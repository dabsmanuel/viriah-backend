import { createRoutes } from '../core/route';
import { z, boolish, hexColour, kobo, name, objectId, pageQuery, phone, email, text, dateStr, idParam } from '../core/validate';
import { accepted, list, ok } from '../core/http';
import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { paging } from '../core/pagination';
import { validation } from '../core/errors';
import { brandTokens } from '../calc/contrast';
import { AuditLog, School } from '../models';
import { publicUrl } from '../integrations/storage';
import { confirmFile } from '../services/files';
import { loadSchool } from '../services/common';
import * as setup from '../services/setup';
import * as schools from '../services/schools';

const r = createRoutes();
export const router = r.router;

async function schoolView() {
  const s: any = await loadSchool();
  return {
    id: String(s._id),
    name: s.name,
    slug: s.slug,
    status: s.status,
    statusReason: s.statusReason,
    resubmissions: s.resubmissions,
    types: s.types,
    motto: s.motto,
    address: s.address,
    phone: s.phone,
    email: s.email,
    registrationNumber: s.registrationNumber,
    branding: {
      logo: publicUrl(s.branding?.logo),
      logoRef: s.branding?.logo,
      favicon: publicUrl(s.branding?.favicon),
      stamp: s.branding?.stamp ? publicUrl(s.branding.stamp) : undefined,
      signature: s.branding?.signature ? publicUrl(s.branding.signature) : undefined,
      primary: s.branding?.primary,
      secondary: s.branding?.secondary,
      tokens: brandTokens(s.branding?.primary, s.branding?.secondary)
    },
    settings: s.settings,
    bank: { configured: !!s.paystack?.subaccountCode, accountName: s.paystack?.accountName, accountLast4: s.paystack?.accountLast4, bankName: s.paystack?.bankName },
    plan: s.plan
  };
}

r.get('/school', { access: { perm: 'school.profile.view' }, inactiveOk: true, summary: 'The school’s profile, branding and settings' }, async () => ok(await schoolView()));

const settingsSchema = z
  .object({
    admissionNumberFormat: z.string().trim().min(3).max(40).regex(/\{SEQ(:\d+)?\}/, 'The format needs {SEQ:4} so each number is different.').optional(),
    receiptPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,6}$/, 'Use 2 to 6 letters or digits.').optional(),
    positionScope: z.enum(['arm', 'level']).optional(),
    annualMethod: z.enum(['mean_of_terms', 'third_term_only']).optional(),
    resultBlock: z.object({ enabled: z.boolean(), thresholdKobo: kobo }).strict().optional(),
    partPayment: z.object({ enabled: z.boolean(), minPercent: z.number().min(0).max(100) }).strict().optional(),
    chargeBearer: z.enum(['parent', 'school']).optional(),
    allowEnrolBeforePayment: z.boolean().optional(),
    absenceSms: z.boolean().optional(),
    registerSessions: z.enum(['day', 'am_pm']).optional(),
    rollbackDays: z.number().int().min(1).max(30).optional(),
    showFeesToStudents: z.boolean().optional(),
    parentAccessEndsAfterDays: z.number().int().min(0).max(365).optional(),
    reminderSchedule: z.object({ enabled: z.boolean(), everyDays: z.number().int().min(1).max(60), sms: z.boolean(), email: z.boolean() }).strict().optional(),
    showFeesOnWebsite: z.boolean().optional()
  })
  .strict();

r.patch(
  '/school',
  {
    access: { perm: 'school.profile.manage' },
    inactiveOk: false,
    body: z
      .object({
        name: name(120).optional(),
        motto: text(160).optional(),
        phone: phone.optional(),
        email: email.optional(),
        types: z.array(z.enum(['nursery', 'primary', 'secondary'])).min(1).optional(),
        address: z.object({ street: text(200).optional(), town: text(80).optional(), lga: name(80), state: name(60) }).strict().optional(),
        registrationNumber: text(60).optional(),
        settings: settingsSchema.optional()
      })
      .strict(),
    summary: 'Update profile and settings'
  },
  async (req) => {
    const school: any = await School.findById(getCtx()!.schoolId);
    const { settings, ...profile } = req.body;
    const before = { profile: { name: school.name, motto: school.motto }, settings: school.settings?.toObject?.() };
    Object.assign(school, profile);
    if (settings) {
      for (const [k, v] of Object.entries(settings)) school.set(`settings.${k}`, v);
      // Settings that change money or results are always audited.
      await audit({ action: 'school.settings.update', entityType: 'school', entityId: school._id, before: before.settings, after: settings });
    }
    await school.save();
    if (Object.keys(profile).length) await audit({ action: 'school.profile.update', entityType: 'school', entityId: school._id, before: before.profile, after: profile });
    return ok(await schoolView());
  }
);

r.patch(
  '/school/branding',
  {
    access: { perm: 'school.branding.manage' },
    body: z.object({ logo: z.string().max(300).optional(), favicon: z.string().max(300).optional(), stamp: z.string().max(300).optional(), signature: z.string().max(300).optional(), primary: hexColour.optional(), secondary: hexColour.optional() }).strict(),
    summary: 'Update logo, colours, favicon, stamp and signature'
  },
  async (req) => {
    const school: any = await School.findById(getCtx()!.schoolId);
    for (const key of ['logo', 'favicon', 'stamp', 'signature'] as const) {
      const ref = req.body[key];
      if (ref === undefined) continue;
      if (ref !== '') await confirmFile(ref, 'brand_asset'); // must exist in this school's folder
      school.set(`branding.${key}`, ref || undefined);
    }
    if (req.body.primary) school.set('branding.primary', req.body.primary.toLowerCase());
    if (req.body.secondary) school.set('branding.secondary', req.body.secondary.toLowerCase());
    await school.save();
    const view = await schoolView();
    return ok({ ...view.branding, warnings: view.branding.tokens.warnings });
  }
);

r.get('/school/setup-progress', { access: { perm: 'school.setup.manage' }, inactiveOk: true, summary: 'Checklist state per step' }, async () => ok(await setup.computeSetupProgress()));

r.post(
  '/setup/apply-presets',
  {
    access: { perm: 'school.setup.manage' },
    body: z.object({
      classLevels: z.union([z.literal('all'), z.array(z.string().max(40)).min(1)]).default('all'),
      subjects: z.boolean().default(true),
      grading: z.boolean().default(true),
      traits: z.boolean().default(true),
      feeItems: z.boolean().default(true),
      commentBank: z.boolean().default(true)
    }).strict(),
    summary: 'Copy chosen presets into the school'
  },
  async (req) => ok(await setup.applyPresets(req.body))
);

r.get('/school/go-live/preview', { access: { perm: 'school.golive' }, inactiveOk: true, summary: 'Counts of parents and students who would receive login details' }, async () => ok(await setup.goLivePreview()));

r.post('/school/go-live', { access: { perm: 'school.golive' }, requireActive: true, idem: true, summary: 'Send login details to parents and students not yet invited' }, async () => {
  const out = await setup.goLive();
  return accepted(out.jobId, { parents: out.parents, students: out.students });
});

r.get(
  '/school/audit-logs',
  { access: { perm: 'school.audit.view' }, query: z.object({ page: pageQuery.page, limit: pageQuery.limit, action: text(80).optional(), userId: objectId.optional(), entityType: text(40).optional(), entityId: text(40).optional(), from: dateStr.optional(), to: dateStr.optional() }).strict(), summary: 'The school’s audit log' },
  async (req) => {
    const q = req.query as any;
    const filter: Record<string, unknown> = { schoolId: getCtx()!.schoolId };
    if (q.action) filter.action = new RegExp(`^${q.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    if (q.userId) filter.actorUserId = q.userId;
    if (q.entityType) filter.entityType = q.entityType;
    if (q.entityId) filter.entityId = q.entityId;
    if (q.from || q.to) filter.at = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(`${q.to}T23:59:59Z`) } : {}) };
    const p = paging(q, ['at', 'action'], '-at');
    const [rows, total] = await Promise.all([AuditLog.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), AuditLog.countDocuments(filter)]);
    return list(
      rows.map((a: any) => ({ id: String(a._id), at: a.at, action: a.action, actorUserId: a.actorUserId ? String(a.actorUserId) : undefined, actorRoles: a.actorRoles, support: a.supportSession, entityType: a.entityType, entityId: a.entityId, reason: a.reason, before: a.before, after: a.after })),
      { page: p.page, limit: p.limit, total }
    );
  }
);

r.post('/school/resubmit', { access: { perm: 'school.profile.manage' }, inactiveOk: true, summary: 'Send a rejected school’s corrected details once more' }, async () => {
  await schools.resubmitSchool();
  return ok({ status: 'pending' });
});

export { boolish, validation, idParam };
