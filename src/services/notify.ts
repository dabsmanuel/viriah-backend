import type { ClientSession } from 'mongoose';
import { getCtx, forSchool } from '../core/context';
import { enqueue, registerJob } from '../jobs/queue';
import { sendEmail } from '../integrations/email';
import { sendSms, smsUnits } from '../integrations/sms';
import { MessageLog, MessageTemplate, Notification, NotificationPref, School, SmsLedger, SmsWallet, User, Membership } from '../models';
import { DEFAULT_TEMPLATES, render, type EventKey, type Template } from '../templates/messages';
import { todayLagos } from '../lib/dates';

/**
 * Notification service (Document 3, section 12.1). Code raises an event with its recipients and data. This service
 * decides the channels from the matrix in Document 2 section 6, the school's settings and the user's preferences.
 * It writes the in-app notification, then queues SMS and email jobs. Every send is recorded in messageLog.
 *
 * Optional SMS uses the school's unit balance, one unit per 160 character part. If the balance is empty the SMS is
 * skipped, the in-app notification is still written, and the owner is alerted once a day. Essential SMS (login codes,
 * payment confirmations, admission status) are always sent and are not charged to the school.
 */

type Policy = 'yes' | 'optional' | 'no';
type RecipientKind = 'parent' | 'owner' | 'admin' | 'staff' | 'student' | 'user';

interface EventSpec {
  sms: Policy | Partial<Record<RecipientKind | 'default', Policy>>;
  email: Policy | Partial<Record<RecipientKind | 'default', Policy>>;
  inApp: boolean;
  /** For optional channels: is it on unless the school switches it off? */
  optionalOn?: { sms?: boolean; email?: boolean };
}

// Document 2, section 6. "Yes" means always sent. "Optional" follows the school's setting and the user's preference.
const EVENTS: Record<EventKey, EventSpec> = {
  login_code: { sms: 'yes', email: { default: 'no' }, inApp: false },
  signup_received: { sms: { owner: 'yes', default: 'no' }, email: 'yes', inApp: false },
  school_decision: { sms: 'yes', email: 'yes', inApp: true },
  staff_invite: { sms: 'yes', email: 'yes', inApp: false },
  application_received: { sms: { parent: 'yes', default: 'no' }, email: { parent: 'optional', default: 'no' }, inApp: true, optionalOn: { email: true } },
  application_status: { sms: 'yes', email: 'optional', inApp: false, optionalOn: { email: true } },
  offer_made: { sms: 'yes', email: 'optional', inApp: false, optionalOn: { email: true } },
  enrolled: { sms: 'yes', email: 'optional', inApp: false, optionalOn: { email: true } },
  invoice_issued: { sms: 'optional', email: 'optional', inApp: true, optionalOn: { email: true } },
  payment_success: { sms: { parent: 'yes', default: 'no' }, email: 'optional', inApp: true, optionalOn: { email: true } },
  proof_uploaded: { sms: 'no', email: 'no', inApp: true },
  proof_decided: { sms: 'yes', email: 'optional', inApp: true, optionalOn: { email: true } },
  fee_reminder: { sms: 'optional', email: 'optional', inApp: true, optionalOn: { email: true } },
  child_absent: { sms: 'optional', email: 'no', inApp: true },
  task_published: { sms: 'no', email: 'no', inApp: true },
  work_marked: { sms: 'no', email: 'no', inApp: true },
  sheet_returned: { sms: 'no', email: 'no', inApp: true },
  result_awaiting_approval: { sms: 'no', email: 'optional', inApp: true, optionalOn: { email: true } },
  results_published: { sms: 'optional', email: 'optional', inApp: true, optionalOn: { sms: true, email: true } },
  result_revised: { sms: 'optional', email: 'optional', inApp: true, optionalOn: { sms: true, email: true } },
  approval_event: { sms: 'no', email: 'optional', inApp: true },
  announcement: { sms: 'optional', email: 'optional', inApp: true },
  bank_changed: { sms: { owner: 'yes', default: 'no' }, email: 'yes', inApp: true },
  password_changed: { sms: 'no', email: 'yes', inApp: true },
  school_status: { sms: { owner: 'yes', default: 'no' }, email: 'yes', inApp: true },
  low_sms_units: { sms: 'no', email: 'yes', inApp: true },
  contact_change: { sms: 'no', email: 'no', inApp: true },
  enquiry_received: { sms: 'no', email: 'no', inApp: true },
  parent_access_ended: { sms: 'no', email: 'no', inApp: true },
  temp_password: { sms: 'yes', email: 'yes', inApp: false }
};

export interface Recipient {
  userId?: string;
  phone?: string;
  email?: string;
  name?: string;
  kind?: RecipientKind;
}

export interface NotifyInput {
  schoolId?: string;
  event: EventKey;
  to: Recipient[];
  vars?: Record<string, string | number | undefined | null>;
  link?: string;
  /** the sender chose these channels (announcements, reminders, absence alerts): optional channels become on */
  force?: { sms?: boolean; email?: boolean };
  /** announcements carry their own title and body */
  inAppOverride?: { title: string; body: string };
  session?: ClientSession;
}

export interface NotifyResult {
  recipients: number;
  inApp: number;
  sms: number;
  email: number;
  smsUnits: number;
  skipped: number;
}

const policyFor = (p: EventSpec['sms'], kind: RecipientKind | undefined): Policy => (typeof p === 'string' ? p : p[kind ?? 'default'] ?? p.default ?? 'no');

async function templateFor(schoolId: string | undefined, event: EventKey, channel: 'sms' | 'email' | 'in_app'): Promise<Template> {
  const base = DEFAULT_TEMPLATES[event];
  if (!schoolId) return base;
  const override = await MessageTemplate.findOne({ schoolId, key: event, channel }).lean();
  if (!override) return base;
  if (channel === 'sms') return { ...base, sms: override.body };
  if (channel === 'email') return { ...base, email: override.body, emailSubject: override.subject || base.emailSubject };
  return { ...base, inApp: override.body };
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const run = () => doNotify(input);
  return input.schoolId ? forSchool(input.schoolId, run) : run();
}

async function doNotify(input: NotifyInput): Promise<NotifyResult> {
  const ctx = getCtx();
  const schoolId = input.schoolId ?? ctx?.schoolId;
  const spec = EVENTS[input.event];
  const result: NotifyResult = { recipients: 0, inApp: 0, sms: 0, email: 0, smsUnits: 0, skipped: 0 };
  const school = schoolId ? await School.findById(schoolId).select('name slug settings').lean() : null;
  const vars = { school: school?.name ?? '', link: input.link ?? '', ...input.vars };

  const seenUsers = new Set<string>();
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();

  // Resolve missing contact details from the user record.
  const recipients: Recipient[] = [];
  for (const r of input.to) {
    let rec = { ...r };
    if (rec.userId && (!rec.phone || !rec.email)) {
      const u = await User.findById(rec.userId).select('phone email firstName lastName').lean();
      if (u) rec = { phone: u.phone ?? undefined, email: u.email ?? undefined, name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(), ...rec };
    }
    recipients.push(rec);
  }
  result.recipients = recipients.length;

  let wallet = school ? await SmsWallet.findOne({}).lean() : null;
  let noUnitsHit = false;

  for (const r of recipients) {
    const rvars = { name: r.name ?? '', ...vars };

    // ------------------------------------------------ in-app
    const inAppOn = (spec.inApp || input.event === 'announcement') && r.userId && schoolId;
    if (inAppOn && !seenUsers.has(r.userId!)) {
      seenUsers.add(r.userId!);
      const tpl = await templateFor(schoolId, input.event, 'in_app');
      const title = input.inAppOverride?.title ?? render(tpl.inAppTitle ?? '', rvars);
      const body = input.inAppOverride?.body ?? render(tpl.inApp ?? '', rvars);
      if (title || body) {
        await Notification.create([{ userId: r.userId, type: input.event, title, body, link: input.link }], input.session ? { session: input.session } : {});
        result.inApp += 1;
      }
    }

    const prefs = r.userId && schoolId ? (await NotificationPref.findOne({ userId: r.userId }).lean())?.prefs ?? {} : {};
    const optedOut = (channel: 'sms' | 'email') => (prefs as any)?.[input.event]?.[channel] === false || (prefs as any)?.all?.[channel] === false;
    const schoolOverride = (channel: 'sms' | 'email') => (school?.settings as any)?.notifyOverrides?.[input.event]?.[channel] as boolean | undefined;

    // ------------------------------------------------ SMS
    const smsPolicy = policyFor(spec.sms, r.kind);
    let sendSmsNow = false;
    let essential = false;
    if (smsPolicy === 'yes') {
      sendSmsNow = true;
      essential = true;
    } else if (smsPolicy === 'optional') {
      const on = input.force?.sms ?? schoolOverride('sms') ?? spec.optionalOn?.sms ?? false;
      sendSmsNow = on && !optedOut('sms');
    } else if (input.force?.sms && input.event === 'announcement') {
      sendSmsNow = !optedOut('sms');
    }
    if (sendSmsNow && r.phone && !seenPhones.has(r.phone)) {
      seenPhones.add(r.phone);
      const tpl = await templateFor(schoolId, input.event, 'sms');
      const message = render(tpl.sms ?? '', rvars);
      if (message) {
        const units = smsUnits(message);
        if (!essential) {
          const ok = schoolId ? await debitUnits(units, `sms:${input.event}`) : true;
          if (!ok) {
            noUnitsHit = true;
            result.skipped += 1;
            if (schoolId) await MessageLog.create([{ channel: 'sms', to: r.phone, templateKey: input.event, status: 'skipped', error: 'no_sms_units', units: 0 }]);
            wallet = null;
          } else {
            result.smsUnits += units;
            await queueSms(schoolId, r.phone, message, input.event, units, false);
            result.sms += 1;
          }
        } else {
          await queueSms(schoolId, r.phone, message, input.event, units, true);
          result.sms += 1;
        }
      }
    }

    // ------------------------------------------------ email
    const emailPolicy = policyFor(spec.email, r.kind);
    let sendEmailNow = false;
    if (emailPolicy === 'yes') sendEmailNow = true;
    else if (emailPolicy === 'optional') {
      const on = input.force?.email ?? schoolOverride('email') ?? spec.optionalOn?.email ?? false;
      sendEmailNow = on && !optedOut('email');
    } else if (input.force?.email && input.event === 'announcement') sendEmailNow = !optedOut('email');
    if (sendEmailNow && r.email && !seenEmails.has(r.email)) {
      seenEmails.add(r.email);
      const tpl = await templateFor(schoolId, input.event, 'email');
      const body = render(tpl.email ?? '', rvars);
      const subject = render(tpl.emailSubject ?? '', rvars);
      if (body) {
        await queueEmail(schoolId, r.email, subject, body, input.event);
        result.email += 1;
      }
    }
  }

  if (noUnitsHit && schoolId) await alertOwnerOnce(schoolId);
  void wallet;
  return result;
}

async function queueSms(schoolId: string | undefined, to: string, message: string, event: string, units: number, essential: boolean) {
  let logId: string | undefined;
  if (schoolId) {
    const log = await MessageLog.create({ channel: 'sms', to, templateKey: event, status: 'queued', units, essential });
    logId = String(log._id);
  }
  await enqueue('send-sms', { logId, to, message, essential, route: essential ? 'transactional' : 'generic' }, { schoolId });
}

async function queueEmail(schoolId: string | undefined, to: string, subject: string, body: string, event: string) {
  let logId: string | undefined;
  if (schoolId) {
    const log = await MessageLog.create({ channel: 'email', to, templateKey: event, status: 'queued', essential: false });
    logId = String(log._id);
  }
  await enqueue('send-email', { logId, to, subject, body }, { schoolId });
}

// ------------------------------------------------------------------ jobs

registerJob('send-sms', async ({ payload }) => {
  try {
    const r = await sendSms(payload.to, payload.message, payload.route);
    if (payload.logId) await MessageLog.updateOne({ _id: payload.logId }, { status: 'sent', providerRef: r.providerRef });
    return { providerRef: r.providerRef };
  } catch (e) {
    if (payload.logId) await MessageLog.updateOne({ _id: payload.logId }, { status: 'failed', error: String((e as Error).message).slice(0, 300) });
    throw e;
  }
});

registerJob('send-email', async ({ payload }) => {
  try {
    const r = await sendEmail(payload.to, payload.subject, payload.body);
    if (payload.logId) await MessageLog.updateOne({ _id: payload.logId }, { status: 'sent', providerRef: r.providerRef });
    return { providerRef: r.providerRef };
  } catch (e) {
    if (payload.logId) await MessageLog.updateOne({ _id: payload.logId }, { status: 'failed', error: String((e as Error).message).slice(0, 300) });
    throw e;
  }
});

// ------------------------------------------------------------------ SMS units

export async function getWallet() {
  const w = await SmsWallet.findOneAndUpdate({}, { $setOnInsert: { units: 0 } }, { upsert: true, new: true });
  return w!;
}

/** Atomic debit. Returns false when the balance is too low. */
export async function debitUnits(units: number, reason: string, ref?: string): Promise<boolean> {
  await getWallet();
  const w = await SmsWallet.findOneAndUpdate({ units: { $gte: units } }, { $inc: { units: -units } }, { new: true });
  if (!w) return false;
  await SmsLedger.create({ delta: -units, reason, ref, balanceAfter: w.units });
  return true;
}

/** Credit units once per payment reference, even if the provider notifies twice. */
export async function creditUnits(units: number, reason: string, ref: string, session?: ClientSession): Promise<boolean> {
  const exists = await SmsLedger.findOne({ ref, reason: 'purchase' }).session(session ?? null).lean();
  if (exists) return false;
  const w = await SmsWallet.findOneAndUpdate({}, { $inc: { units } }, { upsert: true, new: true, session });
  await SmsLedger.create([{ delta: units, reason, ref, balanceAfter: w!.units }], { session });
  return true;
}

/** The owner is alerted once a day when optional SMS are skipped for lack of units. */
async function alertOwnerOnce(schoolId: string) {
  const w = await getWallet();
  const today = todayLagos();
  if (w.lowBalanceAlertOn === today) return;
  await SmsWallet.updateOne({}, { lowBalanceAlertOn: today });
  const owners = await Membership.find({ schoolId, kind: 'staff', roles: 'owner', status: 'active' }).select('userId').lean();
  if (!owners.length) return;
  await notify({ schoolId, event: 'low_sms_units', to: owners.map((o) => ({ userId: String(o.userId), kind: 'owner' as const })) });
}
