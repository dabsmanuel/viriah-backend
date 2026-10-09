import crypto from 'node:crypto';
import { env } from '../config/env';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s: string, secret = env.COOKIE_SECRET) => crypto.createHmac('sha256', secret).update(s).digest('hex');
export const hmac512 = (s: string | Buffer, secret: string) => crypto.createHmac('sha512', secret).update(s).digest('hex');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Numeric one-time code, uniformly distributed. */
export const randomDigits = (n = 6) => {
  let out = '';
  while (out.length < n) out += String(crypto.randomInt(0, 10));
  return out;
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const randomCode = (n = 10) => {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
};

/** Temporary password a person can read from an SMS: 10 chars, mixed. */
export const randomPassword = () => `${randomCode(4)}${randomDigits(3)}${randomCode(3).toLowerCase()}`;

export const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

export const requestHash = (body: unknown) => sha256(JSON.stringify(body ?? {}));
