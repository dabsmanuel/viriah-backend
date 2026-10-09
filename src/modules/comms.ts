import { createRoutes } from '../core/route';
import { z, objectId, text, pageQuery, idParam, name } from '../core/validate';
import { accepted, created, list, ok } from '../core/http';
import { can } from '../core/http';
import { notFound } from '../core/errors';
import { paging } from '../core/pagination';
import { MessageLog, Announcement, School, SmsLedger } from '../models';
import { getCtx } from '../core/context';
import * as comms from '../services/comms';
import { getWallet } from '../services/notify';
import { checkoutSmsUnits } from '../services/payments';
import { EDITABLE_EVENTS, type EventKey } from '../templates/messages';
import { audit } from '../core/audit';

const r = createRoutes();
export const router = r.router;

const audience = z.object({ all: z.boolean().optional(), roles: z.array(z.enum(['parent', 'student', 'owner', 'principal', 'school_admin', 'bursar', 'class_teacher', 'subject_teacher'])).max(8).optional(), classArmIds: z.array(objectId).max(60).optional() }).strict();
const channels = z.array(z.enum(['in_app', 'sms', 'email'])).min(1).max(3);
const ANNOUNCE = { perm: ['comms.announce.school', 'comms.announce.own'] as ('comms.announce.school' | 'comms.announce.own')[] };

r.get('/announcements', { access: { perm: 'comms.announce.view' }, summary: 'Announcements the caller can see, or has sent' }, async () => {
  const rows = await comms.visibleAnnouncements();
  const canSee = can('comms.announce.school') || can('comms.announce.own');
  return ok(rows.map((a) => comms.announcementView(a, canSee)));
});

r.post('/announcements', { access: ANNOUNCE, idem: true, body: z.object({ title: name(120), body: text(2000).min(1), audience, channels }).strict(), summary: 'Send an announcement to an audience by chosen channels' }, async (req) => created(comms.announcementView(await comms.sendAnnouncement(req.body), true)));

r.post('/announcements/estimate', { access: ANNOUNCE, body: z.object({ audience, channels }).strict(), summary: 'Number of recipients and SMS units an announcement would use' }, async (req) => ok(await comms.estimate(req.body.audience, req.body.channels)));

r.get('/announcements/:id', { access: { perm: 'comms.announce.view' }, params: idParam, summary: 'One announcement with delivery counts' }, async (req) => {
  const visible = await comms.visibleAnnouncements();
  const a = visible.find((x) => String(x._id) === req.params.id);
  if (!a) throw notFound('Announcement');
  return ok(comms.announcementView(a, can('comms.announce.school') || can('comms.announce.own')));
});

// ------------------------------------------------------------------ notification centre

r.get('/notifications', { access: { perm: 'notifications.own' }, inactiveOk: true, query: z.object({ page: pageQuery.page, limit: pageQuery.limit, unread: z.enum(['true']).optional() }).strict(), summary: 'The caller’s in-app notifications' }, async (req) => {
  const q = req.query as any;
  const out = await comms.myNotifications(q.page, q.limit, !!q.unread);
  return list(out.rows, { page: q.page, limit: q.limit, total: out.total }, { unread: out.unread });
});

r.post('/notifications/read', { access: { perm: 'notifications.own' }, inactiveOk: true, body: z.object({ ids: z.array(objectId).max(200).optional() }).strict().optional(), summary: 'Mark some or all as read' }, async (req) => ok(await comms.markRead((req.body as any)?.ids)));

const prefsSchema = z.record(z.string().max(40), z.object({ sms: z.boolean().optional(), email: z.boolean().optional() }).strict());
r.get('/notification-preferences', { access: { perm: 'notifications.own' }, inactiveOk: true, summary: 'The caller’s preferences' }, async () => ok(await comms.getPrefs()));
r.put('/notification-preferences', { access: { perm: 'notifications.own' }, inactiveOk: true, body: prefsSchema, summary: 'Update preferences' }, async (req) => ok(await comms.setPrefs(req.body)));

// ------------------------------------------------------------------ templates, units, log

r.get('/message-templates', { access: { perm: 'comms.templates.manage' }, summary: 'The school’s templates with the platform defaults' }, async () => ok(await comms.listTemplates()));
r.put('/message-templates/:key', { access: { perm: 'comms.templates.manage' }, params: z.object({ key: z.enum(EDITABLE_EVENTS as [EventKey, ...EventKey[]]) }).strict(), body: z.object({ sms: z.string().max(480).optional(), email: z.string().max(4000).optional(), emailSubject: z.string().max(200).optional() }).strict(), summary: 'Edit an optional template' }, async (req) => ok(await comms.saveTemplate(req.params.key as EventKey, req.body)));

r.get('/sms/wallet', { access: { perm: 'comms.sms.view' }, summary: 'Unit balance' }, async () => {
  const w: any = await getWallet();
  return ok({ units: w.units });
});

r.post('/sms/purchase', { access: { perm: 'comms.sms.purchase' }, idem: true, requireActive: true, body: z.object({ units: z.number().int().min(10).max(100000) }).strict(), summary: 'Start a payment for units' }, async (req) => created(await checkoutSmsUnits(req.body.units)));

r.get('/sms/ledger', { access: { perm: 'comms.sms.view' }, summary: 'Purchases and usage' }, async () => ok(await comms.ledger()));

r.get('/messages/log', { access: { perm: 'comms.log.view' }, query: z.object({ ...pageQuery, status: z.enum(['queued', 'sent', 'delivered', 'failed', 'skipped']).optional(), channel: z.enum(['sms', 'email']).optional() }).strict(), summary: 'Messages sent, with status' }, async (req) => {
  const q = req.query as any;
  const filter: any = {};
  if (q.status) filter.status = q.status;
  if (q.channel) filter.channel = q.channel;
  const p = paging(q, ['createdAt'], '-createdAt');
  const [rows, total] = await Promise.all([MessageLog.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), MessageLog.countDocuments(filter)]);
  return list(rows.map((m: any) => ({ id: String(m._id), channel: m.channel, to: m.to ? `${m.to.slice(0, 6)}****${m.to.slice(-2)}` : undefined, template: m.templateKey, status: m.status, units: m.units, essential: m.essential, error: m.error, createdAt: m.createdAt })), { page: p.page, limit: p.limit, total });
});

// ------------------------------------------------------------------ fee reminders

r.get('/fees/reminders/settings', { access: { perm: 'fees.reminders.manage' }, summary: 'Reminder schedule' }, async () => {
  const s: any = await School.findById(getCtx()!.schoolId).select('settings.reminderSchedule').lean();
  return ok(s.settings?.reminderSchedule ?? { enabled: false, everyDays: 7, sms: false, email: false });
});

r.put('/fees/reminders/settings', { access: { perm: 'fees.reminders.manage' }, body: z.object({ enabled: z.boolean(), everyDays: z.number().int().min(1).max(60), sms: z.boolean(), email: z.boolean() }).strict(), summary: 'Set the reminder schedule' }, async (req) => {
  await School.updateOne({ _id: getCtx()!.schoolId }, { $set: { 'settings.reminderSchedule.enabled': req.body.enabled, 'settings.reminderSchedule.everyDays': req.body.everyDays, 'settings.reminderSchedule.sms': req.body.sms, 'settings.reminderSchedule.email': req.body.email } });
  await audit({ action: 'fees.reminders.settings', entityType: 'school', entityId: getCtx()!.schoolId, after: req.body });
  return ok(req.body);
});

r.post('/fees/reminders/send', { access: { perm: 'fees.reminders.manage' }, idem: true, requireActive: true, body: z.object({ studentIds: z.array(objectId).max(500).optional(), sms: z.boolean().default(false), email: z.boolean().default(false) }).strict(), summary: 'Send a reminder now to chosen debtors' }, async (req) => accepted(await comms.queueReminders(req.body)));

export { Announcement, SmsLedger };
