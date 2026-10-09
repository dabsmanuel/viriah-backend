import { env, isLocal, isTest } from '../config/env';
import { logger } from '../core/logger';

/**
 * SMS through Termii. A console driver is used when no key is set (local, staging without a key, tests).
 * Codes go through the transactional route (channel "dnd") so they reach numbers with do-not-disturb on.
 */

export type SmsRoute = 'transactional' | 'generic';

export interface SmsDriver {
  name: string;
  send(to: string, message: string, route: SmsRoute): Promise<{ providerRef?: string }>;
}

export interface OutboxEntry {
  channel: 'sms' | 'email';
  to: string;
  body: string;
  subject?: string;
  at: Date;
}

/** In-memory outbox for local development and tests. Never used in production. */
export const outbox: OutboxEntry[] = [];
export const clearOutbox = () => (outbox.length = 0);
export const lastSmsTo = (phone: string) => [...outbox].reverse().find((o) => o.channel === 'sms' && o.to === phone);
export const lastCodeFor = (target: string): string | undefined => {
  const e = [...outbox].reverse().find((o) => o.to === target && /\b\d{6}\b/.test(o.body));
  return e?.body.match(/\b(\d{6})\b/)?.[1];
};

const consoleDriver: SmsDriver = {
  name: 'console',
  async send(to, message) {
    if (isLocal) outbox.push({ channel: 'sms', to, body: message, at: new Date() });
    if (!isTest) logger.info({ to: to.slice(0, 6) + '****', length: message.length }, `[sms:console] ${message}`);
    return { providerRef: `console-${Date.now()}` };
  }
};

const termiiDriver: SmsDriver = {
  name: 'termii',
  async send(to, message, route) {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: to.replace('+', ''),
        from: env.TERMII_SENDER_ID,
        sms: message,
        type: 'plain',
        channel: route === 'transactional' ? 'dnd' : 'generic',
        api_key: env.TERMII_API_KEY
      })
    });
    const json = (await res.json().catch(() => ({}))) as { message_id?: string; message?: string };
    if (!res.ok) throw new Error(`Termii error ${res.status}: ${json.message ?? 'send failed'}`);
    return { providerRef: json.message_id };
  }
};

let driver: SmsDriver = env.TERMII_API_KEY ? termiiDriver : consoleDriver;

export const setSmsDriver = (d: SmsDriver) => (driver = d);
export const smsDriver = () => driver;

/** On staging, SMS is limited to an allow list of numbers. */
function allowed(to: string): boolean {
  if (env.APP_ENV !== 'staging' || !env.SMS_ALLOW_LIST) return true;
  return env.SMS_ALLOW_LIST.split(',').map((s) => s.trim()).includes(to);
}

/** Number of 160 character parts. One unit per part. */
export const smsUnits = (message: string) => Math.max(1, Math.ceil(message.length / 160));

export async function sendSms(to: string, message: string, route: SmsRoute = 'generic') {
  if (!allowed(to)) return { providerRef: 'skipped-allowlist' };
  return driver.send(to, message, route);
}
