import { createRoutes } from '../core/route';
import { z, objectId, name, text, dateStr, phone, email, kobo, pageQuery, idParam, code6 } from '../core/validate';
import { accepted, created, list, ok } from '../core/http';
import * as adm from '../services/admissions';
import { runExpireOffers } from '../services/admissions';
import { drainJobs } from '../jobs/queue';
import { normalizePhone } from '../lib/phone';
import { isLocal } from '../config/env';

const r = createRoutes();
export const router = r.router;

const formRate = { name: 'application', windowMs: 60 * 60_000, max: 60 };
const bearer = (req: any) => (req.header('x-application-token') as string | undefined) ?? (req.header('authorization')?.replace(/^Bearer /, '') as string | undefined);

// ------------------------------------------------------------------ public: the application form (F5)

r.get('/public/admissions', { access: 'public', host: true, summary: 'Whether admissions are open, classes open, required fields and uploads, application fee, consent text' }, async () => ok(await adm.publicAdmissions()));

r.post('/public/applications/start', { access: 'public', host: true, rate: formRate, body: z.object({ phone }).strict(), summary: 'Send an SMS code to the parent’s phone' }, async (req) => {
  await adm.startApplication(req.body.phone, req);
  return ok({ sent: true });
});

r.post('/public/applications/verify', { access: 'public', host: true, rate: formRate, body: z.object({ phone, code: code6 }).strict(), summary: 'Confirm the code. Returns an application token and any saved draft' }, async (req) => ok(await adm.verifyApplication(req.body.phone, req.body.code)));

const personPart = z.object({ firstName: z.string().trim().max(60).optional(), middleName: z.string().trim().max(60).optional(), lastName: z.string().trim().max(60).optional(), dob: dateStr.optional(), gender: z.enum(['male', 'female']).optional(), phone: z.string().max(20).optional(), email: email.optional(), address: text(300).optional(), relationship: text(30).optional(), stateOfOrigin: text(60).optional(), religion: text(40).optional() }).strict();
r.put(
  '/public/applications/draft',
  {
    access: 'public',
    host: true,
    rate: formRate,
    body: z.object({ child: personPart.optional(), guardian: personPart.optional(), classLevelId: objectId.optional(), previousSchool: text(160).optional(), documents: z.array(z.object({ kind: z.enum(['birth_certificate', 'last_result', 'passport', 'other']), file: z.string().min(10).max(300), name: text(120).optional() }).strict()).max(8).optional() }).strict(),
    summary: 'Save the draft'
  },
  async (req) => ok(await adm.saveDraft(bearer(req), req.body))
);

r.post('/public/applications/files/sign', { access: 'public', host: true, rate: formRate, body: z.object({ kind: z.enum(['birth_certificate', 'last_result', 'passport', 'other']), mime: z.string().max(120) }).strict(), summary: 'Signed upload parameters for an application document' }, async (req) => ok(await adm.signApplicationFile(bearer(req), req.body)));

r.post('/public/applications/submit', { access: 'public', host: true, activeSchool: true, rate: formRate, body: z.object({ consent: z.boolean() }).strict(), summary: 'Submit the application. Starts payment first if a fee is set' }, async (req) => {
  const out = await adm.submitApplication(bearer(req), { consent: req.body.consent, ip: req.ip });
  return created(out);
});

r.get('/public/applications/status', { access: 'public', host: true, rate: { name: 'app-status', windowMs: 60_000, max: 30 }, query: z.object({ number: z.string().min(5).max(40), phone }).strict(), summary: 'Status by application number and phone' }, async (req) => {
  const q = req.query as any;
  return ok(await adm.applicationStatus(q.number, normalizePhone(q.phone)!));
});

r.get('/public/applications/offer/:token', { access: 'public', host: true, rate: { name: 'offer', windowMs: 60_000, max: 30 }, params: z.object({ token: z.string().min(20).max(60) }).strict(), summary: 'The offer and its invoice, from the link sent to the parent' }, async (req) => ok(await adm.offerView(req.params.token as string)));

r.post('/public/applications/offer/:token/pay', { access: 'public', host: true, activeSchool: true, rate: { name: 'offer-pay', windowMs: 60_000, max: 10 }, params: z.object({ token: z.string().min(20).max(60) }).strict(), summary: 'Start payment of the offer invoice' }, async (req) => created(await adm.payOffer(req.params.token as string)));

// ------------------------------------------------------------------ staff

r.get('/admissions/settings', { access: { perm: 'admissions.settings.manage' }, query: z.object({ sessionId: objectId.optional() }).strict(), summary: 'Admission settings for a session' }, async (req) => ok(await adm.admissionSettings((req.query as any).sessionId)));

r.put(
  '/admissions/settings',
  {
    access: { perm: 'admissions.settings.manage' },
    body: z.object({
      sessionId: objectId.optional(),
      open: z.boolean().optional(),
      opensOn: dateStr.optional(),
      closesOn: dateStr.optional(),
      classLevelIds: z.array(objectId).max(30).optional(),
      requiredFields: z.array(z.enum(['child.middleName', 'child.address', 'child.stateOfOrigin', 'child.religion', 'guardian.email', 'guardian.address', 'previousSchool'])).max(10).optional(),
      requiredDocuments: z.array(z.enum(['birth_certificate', 'last_result', 'passport', 'other'])).max(4).optional(),
      applicationFeeKobo: kobo.optional(),
      offerValidDays: z.number().int().min(1).max(90).optional(),
      consentText: text(1200).optional()
    }).strict(),
    summary: 'Update settings, open or close admissions'
  },
  async (req) => ok(await adm.saveAdmissionSettings(req.body))
);

r.get('/applications', { access: { perm: 'admissions.review' }, query: z.object({ ...pageQuery, status: z.enum(['submitted', 'under_review', 'assessment_scheduled', 'offered', 'accepted', 'enrolled', 'waitlisted', 'rejected', 'withdrawn', 'expired']).optional() }).strict(), summary: 'List applications by status' }, async (req) => {
  const q = req.query as any;
  const out = await adm.listApplications(q);
  return list(out.rows, { page: q.page, limit: q.limit, total: out.total }, { counts: out.counts });
});

r.get('/applications/:id', { access: { perm: 'admissions.review' }, params: idParam, summary: 'One application with documents and history' }, async (req) => ok(await adm.applicationDetail(req.params.id as string)));

r.post('/applications/:id/status', { access: { perm: 'admissions.decide' }, params: idParam, body: z.object({ status: z.enum(['under_review', 'waitlisted', 'rejected', 'withdrawn']), note: text(300).optional() }).strict(), summary: 'Move to under review, waitlisted, rejected or withdrawn' }, async (req) => {
  const a = await adm.changeApplicationStatus(req.params.id as string, req.body.status, req.body.note);
  return ok({ id: String(a._id), status: a.status });
});

r.post('/applications/:id/assessment', { access: { perm: 'admissions.decide' }, params: idParam, body: z.object({ kind: z.enum(['test', 'interview']), at: z.string().datetime({ offset: true }), notes: text(300).optional() }).strict(), summary: 'Schedule an entrance test or interview' }, async (req) => {
  const a = await adm.scheduleAssessment(req.params.id as string, req.body);
  return ok({ id: String(a._id), status: a.status, assessment: a.assessment });
});

const offerBody = z.object({ classLevelId: objectId.optional(), amountKobo: kobo.optional(), label: text(80).optional(), expiresOn: dateStr.optional() }).strict();
r.post('/applications/:id/offer', { access: { perm: 'admissions.decide' }, params: idParam, body: offerBody, summary: 'Make an offer for a class. Raises the invoice and sends the link' }, async (req) => {
  const out = await adm.makeOffer(req.params.id as string, req.body);
  return created({ id: String(out.application._id), status: out.application.status, invoiceId: String(out.invoice._id), totalKobo: out.invoice.totalKobo, expiresOn: out.application.offer.expiresOn });
});
r.post('/applications/:id/renew-offer', { access: { perm: 'admissions.decide' }, params: idParam, body: offerBody.optional(), summary: 'Renew an expired offer' }, async (req) => {
  const out = await adm.makeOffer(req.params.id as string, (req.body as any) ?? {}, true);
  return ok({ id: String(out.application._id), status: out.application.status, expiresOn: out.application.offer.expiresOn });
});

r.post('/applications/:id/enrol', { access: { perm: 'admissions.enrol' }, idem: true, params: idParam, body: z.object({ classArmId: objectId, confirmDuplicate: z.boolean().optional() }).strict(), summary: 'Enrol: create student, guardian, enrolment and accounts' }, async (req) => created(await adm.enrolApplication(req.params.id as string, req.body)));

/** Staff can run the daily expiry now (it also runs on a schedule). */
r.post('/applications/expire-offers', { access: { perm: 'admissions.decide' }, summary: 'Mark unpaid offers past their date as expired' }, async () => {
  const id = await runExpireOffers();
  if (isLocal) await drainJobs();
  return accepted(id);
});

export { name };
