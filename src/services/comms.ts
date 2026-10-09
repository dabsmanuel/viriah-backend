import { audit } from '../core/audit';
import { getCtx } from '../core/context';
import { forbidden, validation } from '../core/errors';
import { can, me } from '../core/http';
import { formatKobo } from '../lib/money';
import { schoolLink } from '../lib/links';
import { smsUnits } from '../integrations/sms';
import { enqueue, registerJob } from '../jobs/queue';
import { todayLagos, diffDays } from '../lib/dates';
import { Announcement, Enrolment, Guardian, Invoice, MessageTemplate, Notification, NotificationPref, School, Staff, Student, StudentGuardian, SmsLedger } from '../models';
import { DEFAULT_TEMPLATES, EDITABLE_EVENTS, missingPlaceholders, render, type EventKey } from '../templates/messages';
import { fullName, loadSchool, need } from './common';
import { getWallet, notify, type Recipient } from './notify';
import { currentSession, hasFullReach, myChildIds, myTeaching } from './reach';

/** Announcements, notifications, templates, SMS units and fee reminders (COM-01, COM-02, COM-06, FEE-11). */

export interface Audience {
  all?: boolean;
  roles?: string[];
  classArmIds?: string[];
}

const PARENT_ROLES = ['parent', 'student'];

/**
 * Audience resolution with de-duplication: an announcement to JSS 1 parents reaches only them, and a guardian with two
 * children in JSS 1 gets one message.
 */
export async function resolveAudience(a: Audience): Promise<Recipient[]> {
  const out = new Map<string, Recipient>();
  const add = (key: string, r: Recipient) => {
    if (!out.has(key)) out.set(key, r);
  };
  const wantAll = !!a.all;
  const roles = new Set(a.roles ?? []);
  const arms = a.classArmIds ?? [];
  const wantParents = wantAll || roles.has('parent') || (arms.length > 0 && roles.size === 0);
  const wantStudents = wantAll || roles.has('student') || false;

  if (wantParents || wantStudents) {
    const session = await currentSession();
    const enrolFilter: any = { sessionId: session?._id };
    if (arms.length) enrolFilter.classArmId = { $in: arms };
    const enrolments: any[] = session ? await Enrolment.find(enrolFilter).select('studentId').lean() : [];
    const students: any[] = await Student.find({ _id: { $in: enrolments.map((e) => e.studentId) }, status: 'active' }).select('userId firstName lastName').lean();
    const studentIds = students.map((s) => s._id);
    if (wantParents) {
      const links: any[] = await StudentGuardian.find({ studentId: { $in: studentIds }, access: { $ne: 'none' } }).select('guardianId').lean();
      const guardians: any[] = await Guardian.find({ _id: { $in: [...new Set(links.map((l) => String(l.guardianId)))] } }).lean();
      for (const g of guardians) add(`g:${g._id}`, { userId: g.userId ? String(g.userId) : undefined, phone: g.phone, email: g.email, name: fullName(g), kind: 'parent' });
    }
    if (wantStudents) for (const s of students) if (s.userId) add(`s:${s._id}`, { userId: String(s.userId), name: fullName(s), kind: 'student' });
  }

  const staffRoles = [...roles].filter((r) => !PARENT_ROLES.includes(r));
  if (wantAll || staffRoles.length) {
    const filter: any = { status: 'active' };
    if (!wantAll) filter.roles = { $in: staffRoles };
    const staff: any[] = await Staff.find(filter).lean();
    for (const s of staff) add(`t:${s._id}`, { userId: s.userId ? String(s.userId) : undefined, phone: s.phone, email: s.email, name: fullName(s), kind: 'staff' });
  }
  // A class teacher is also told about their own classes' announcements through the class audience; nothing more is added here.
  return [...out.values()];
}

/** Teachers may announce only to their own classes. */
async function assertMayAnnounce(audience: Audience) {
  if (can('comms.announce.school')) return;
  if (!can('comms.announce.own')) throw forbidden();
  if (audience.all || audience.roles?.length || !audience.classArmIds?.length) throw forbidden('You can send announcements to your own classes only.');
  const t = await myTeaching();
  for (const arm of audience.classArmIds) if (!t.arms.has(arm)) throw forbidden('You can send announcements to your own classes only.');
}

export async function estimate(audience: Audience, channels: string[]) {
  await assertMayAnnounce(audience);
  const recipients = await resolveAudience(audience);
  const wantsSms = channels.includes('sms');
  const smsRecipients = wantsSms ? recipients.filter((r) => r.phone).length : 0;
  const wallet: any = await getWallet();
  return { recipients: recipients.length, smsRecipients, emailRecipients: channels.includes('email') ? recipients.filter((r) => r.email).length : 0, smsUnitsNeeded: smsRecipients, smsUnitsAvailable: wallet.units, enough: !wantsSms || wallet.units >= smsRecipients };
}

export async function sendAnnouncement(input: { title: string; body: string; audience: Audience; channels: Array<'in_app' | 'sms' | 'email'> }) {
  const c = me();
  await assertMayAnnounce(input.audience);
  const recipients = await resolveAudience(input.audience);
  if (!recipients.length) throw validation('No one is in that audience.', { audience: 'Empty audience.' });
  const school: any = await loadSchool();
  const sms = input.channels.includes('sms');
  const email = input.channels.includes('email');
  // The SMS text is the title and body; one unit per 160 characters.
  const result = await notify({
    event: 'announcement',
    to: recipients,
    vars: { title: input.title, body: input.body },
    force: { sms, email },
    link: schoolLink(school.slug, '/portal'),
    inAppOverride: { title: input.title, body: input.body }
  });
  const doc: any = await Announcement.create({
    title: input.title,
    body: input.body,
    audience: { all: !!input.audience.all, roles: input.audience.roles ?? [], classArmIds: input.audience.classArmIds ?? [] },
    channels: input.channels,
    sentBy: c.userId,
    sentAt: new Date(),
    counts: { recipients: result.recipients, sms: result.sms, email: result.email, inApp: result.inApp, smsUnits: result.smsUnits, skipped: result.skipped }
  });
  await audit({ action: 'comms.announcement.send', entityType: 'announcement', entityId: doc._id, after: doc.counts });
  return doc;
}

/** Announcements the caller can see: staff see what was sent, parents and students see the ones addressed to them. */
export async function visibleAnnouncements() {
  const c = me();
  const all: any[] = await Announcement.find({}).sort({ sentAt: -1 }).limit(200).lean();
  if (can('comms.announce.school')) return all.slice(0, 100);
  if (can('comms.announce.own') && !c.roles.some((r) => PARENT_ROLES.includes(r))) return all.filter((a) => String(a.sentBy) === c.userId).slice(0, 100);

  // parent or student: by their children's classes, their role and "everyone"
  const kids = c.roles.includes('parent') ? await myChildIds() : c.studentId ? [c.studentId] : [];
  const session = await currentSession();
  const arms = session ? (await Enrolment.find({ sessionId: session._id, studentId: { $in: kids } }).select('classArmId').lean()).map((e: any) => String(e.classArmId)) : [];
  return all
    .filter((a) => {
      const aud = a.audience ?? {};
      if (aud.all) return true;
      const armMatch = (aud.classArmIds ?? []).length > 0 && (aud.classArmIds ?? []).some((x: any) => arms.includes(String(x)));
      if (armMatch) return true;
      if ((aud.classArmIds ?? []).length === 0 && (aud.roles ?? []).some((r: string) => c.roles.includes(r))) return true;
      return false;
    })
    .slice(0, 100);
}

export const announcementView = (a: any, withCounts: boolean) => ({ id: String(a._id), title: a.title, body: a.body, audience: a.audience, channels: a.channels, sentAt: a.sentAt, ...(withCounts ? { counts: a.counts } : {}) });

// ------------------------------------------------------------------ notification centre and preferences

export async function myNotifications(page: number, limit: number, unreadOnly: boolean) {
  const c = me();
  const filter: any = { userId: c.userId, ...(unreadOnly ? { readAt: { $exists: false } } : {}) };
  const [rows, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId: c.userId, readAt: { $exists: false } })
  ]);
  return { rows: rows.map((n: any) => ({ id: String(n._id), type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.readAt, createdAt: n.createdAt })), total, unread };
}

export async function markRead(ids?: string[]) {
  const c = me();
  const res = await Notification.updateMany({ userId: c.userId, readAt: { $exists: false }, ...(ids?.length ? { _id: { $in: ids } } : {}) }, { readAt: new Date() });
  return { updated: res.modifiedCount };
}

/** Each user chooses which optional notifications they receive by SMS and email. Essential messages (login codes, payment receipts) are always sent. */
export async function getPrefs() {
  const c = me();
  const doc: any = await NotificationPref.findOne({ userId: c.userId }).lean();
  return doc?.prefs ?? {};
}
export async function setPrefs(prefs: Record<string, { sms?: boolean; email?: boolean }>) {
  const c = me();
  await NotificationPref.updateOne({ userId: c.userId }, { $set: { prefs } }, { upsert: true });
  return prefs;
}

// ------------------------------------------------------------------ templates

export async function listTemplates() {
  const overrides: any[] = await MessageTemplate.find({ schoolId: getCtx()!.schoolId }).lean();
  return EDITABLE_EVENTS.map((key) => {
    const base = DEFAULT_TEMPLATES[key];
    const sms = overrides.find((o) => o.key === key && o.channel === 'sms');
    const email = overrides.find((o) => o.key === key && o.channel === 'email');
    return {
      key,
      sms: { body: sms?.body ?? base.sms ?? '', default: base.sms ?? '', edited: !!sms },
      email: { subject: email?.subject ?? base.emailSubject ?? '', body: email?.body ?? base.email ?? '', default: base.email ?? '', edited: !!email },
      required: base.required ?? []
    };
  });
}

export async function saveTemplate(key: EventKey, input: { sms?: string; email?: string; emailSubject?: string }) {
  if (!EDITABLE_EVENTS.includes(key)) throw validation('That message cannot be edited.', { key: 'Not editable.' });
  const schoolId = getCtx()!.schoolId;
  for (const [channel, body] of [['sms', input.sms], ['email', input.email]] as const) {
    if (body === undefined) continue;
    const missing = missingPlaceholders(key, body);
    if (missing.length) throw validation(`The message needs ${missing.map((m) => `{{${m}}}`).join(' and ')}.`, { [channel]: `Keep ${missing.map((m) => `{{${m}}}`).join(', ')} in the text.` });
    if (body.trim() === '') {
      await MessageTemplate.deleteOne({ schoolId, key, channel }); // empty means back to the default
      continue;
    }
    await MessageTemplate.updateOne({ schoolId, key, channel }, { $set: { body, ...(channel === 'email' && input.emailSubject !== undefined ? { subject: input.emailSubject } : {}) } }, { upsert: true });
  }
  await audit({ action: 'comms.template.update', entityType: 'messageTemplate', entityId: key });
  return (await listTemplates()).find((t) => t.key === key);
}

// ------------------------------------------------------------------ fee reminders

/** Parents with an open balance, and only them. Sent on the school's schedule or on demand to selected debtors. */
export async function sendFeeReminders(opts: { studentIds?: string[]; sms?: boolean; email?: boolean }) {
  const school: any = await loadSchool();
  const match: any = { status: { $in: ['issued', 'part_paid'] }, balanceKobo: { $gt: 0 } };
  if (opts.studentIds?.length) match.studentId = { $in: opts.studentIds };
  const groups: any[] = await Invoice.aggregate([{ $match: match }, { $group: { _id: '$studentId', balanceKobo: { $sum: '$balanceKobo' } } }]);
  let reminded = 0;
  const totals = { sms: 0, email: 0, inApp: 0, smsUnits: 0, skipped: 0 };
  for (const g of groups) {
    if (!g._id) continue;
    const student: any = await Student.findById(g._id).select('firstName lastName status').lean();
    if (!student || student.status !== 'active') continue;
    const links: any[] = await StudentGuardian.find({ studentId: g._id, isFeePayer: true, access: { $ne: 'none' } }).lean();
    const guardians: any[] = await Guardian.find({ _id: { $in: links.map((l) => l.guardianId) } }).lean();
    if (!guardians.length) continue;
    const r = await notify({
      event: 'fee_reminder',
      to: guardians.map((x) => ({ userId: x.userId ? String(x.userId) : undefined, phone: x.phone, email: x.email, name: fullName(x), kind: 'parent' as const })),
      vars: { child: fullName(student), amount: `₦${formatKobo(g.balanceKobo)}`, link: schoolLink(school.slug, '/portal/parent/fees') },
      force: { sms: !!opts.sms, email: !!opts.email }
    });
    totals.sms += r.sms;
    totals.email += r.email;
    totals.inApp += r.inApp;
    totals.smsUnits += r.smsUnits;
    totals.skipped += r.skipped;
    reminded += 1;
  }
  await audit({ action: 'fees.reminders.send', entityType: 'school', entityId: school._id, after: { reminded, ...totals } });
  return { reminded, ...totals };
}

registerJob('fee-reminders', async ({ payload, schoolId }) => {
  const school: any = await School.findById(schoolId).lean();
  const sched = school?.settings?.reminderSchedule;
  if (payload.scheduled) {
    if (!sched?.enabled || school.status !== 'active') return { skipped: true };
    const today = todayLagos();
    if (sched.lastRunOn && diffDays(today, sched.lastRunOn) < (sched.everyDays ?? 7)) return { skipped: true };
    const out = await sendFeeReminders({ sms: !!sched.sms, email: !!sched.email });
    await School.updateOne({ _id: schoolId }, { 'settings.reminderSchedule.lastRunOn': today });
    return out;
  }
  return sendFeeReminders({ studentIds: payload.studentIds, sms: !!payload.sms, email: !!payload.email });
});

export async function queueReminders(input: { studentIds?: string[]; sms?: boolean; email?: boolean }) {
  const c = me();
  return enqueue('fee-reminders', input as any, { schoolId: c.schoolId, userId: c.userId });
}

export const ledger = async (limit = 100) => SmsLedger.find({}).sort({ createdAt: -1 }).limit(limit).lean();
export { need, smsUnits, render, hasFullReach };
