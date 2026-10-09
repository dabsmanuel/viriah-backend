import { env, isLocal, isTest } from '../config/env';
import { logger } from '../core/logger';
import { outbox } from './sms';

/** Transactional email. Any provider with an HTTP API will do; Resend is wired here. Console driver when no key is set. */

export interface EmailDriver {
  name: string;
  send(to: string, subject: string, text: string, html?: string): Promise<{ providerRef?: string }>;
}

const consoleDriver: EmailDriver = {
  name: 'console',
  async send(to, subject, text) {
    if (isLocal) outbox.push({ channel: 'email', to, subject, body: text, at: new Date() });
    if (!isTest) logger.info({ subject }, `[email:console] to ${to.replace(/^(.).*(@.*)$/, '$1***$2')}: ${text.slice(0, 200)}`);
    return { providerRef: `console-${Date.now()}` };
  }
};

const resendDriver: EmailDriver = {
  name: 'resend',
  async send(to, subject, text, html) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text, html })
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`Email error ${res.status}: ${json.message ?? 'send failed'}`);
    return { providerRef: json.id };
  }
};

let driver: EmailDriver = env.EMAIL_API_KEY ? resendDriver : consoleDriver;
export const setEmailDriver = (d: EmailDriver) => (driver = d);
export const sendEmail = (to: string, subject: string, text: string, html?: string) => driver.send(to, subject, text, html);
