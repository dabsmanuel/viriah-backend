import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { isTest } from '../config/env';
import { validation } from '../core/errors';

/** Passwords are hashed with argon2id. Minimum 8 characters, checked against a list of common passwords. */
const COST = isTest ? { memoryCost: 1024, timeCost: 1, parallelism: 1 } : { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => argonHash(pw, COST);

export async function checkPassword(hash: string | undefined | null, pw: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argonVerify(hash, pw);
  } catch {
    return false;
  }
}

let dummy: string | undefined;
/** Run a verify against a fixed hash so unknown users and wrong passwords take the same time. */
export async function dummyVerify(pw: string) {
  dummy ??= await hashPassword('not-a-real-password');
  await checkPassword(dummy, pw);
}

const COMMON = new Set(
  (
    'password,password1,password12,password123,password1234,12345678,123456789,1234567890,11111111,00000000,qwertyui,qwerty123,qwertyuiop,' +
    'abc12345,abcd1234,iloveyou,iloveyou1,admin123,admin1234,welcome1,welcome123,letmein1,letmein123,monkey123,dragon123,football,football1,' +
    'baseball,sunshine,princess,princess1,trustno1,passw0rd,p@ssw0rd,p@ssword,master123,login123,school123,school1234,nigeria123,nigeria1,' +
    'lagos1234,naija123,godisgood,godislove,jesus123,jesuschrist,blessing1,blessing123,changeme,changeme1,changeme123,default123,test1234,' +
    'testing123,user1234,guest123,hello123,hello1234,asdfghjk,asdf1234,zxcvbnm1,1q2w3e4r,1qaz2wsx,q1w2e3r4,987654321,87654321,12341234,' +
    'password!,passwords,secret123,secretpass,mypassword,mypass123,letmein!,iloveyou!,welcome!,summer2024,summer2025,summer2026,winter2025,' +
    'january1,february1,march2026,april2026,2026school,school2026,student123,teacher123,parent123,bursar123,principal1,proprietor,viriah123'
  ).split(',')
);

export function assertPasswordOk(pw: string, personal: Array<string | undefined | null> = []) {
  if (pw.length < 8) throw validation('Use at least 8 characters.', { password: 'Use at least 8 characters.' });
  if (pw.length > 128) throw validation('Use at most 128 characters.', { password: 'Too long.' });
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw) || /^(0123456789|1234567890|abcdefgh)/.test(lower)) {
    throw validation('That password is too common. Choose a different one.', { password: 'Too common. Choose a different one.' });
  }
  for (const p of personal) {
    if (p && p.length >= 4 && lower.includes(p.toLowerCase())) {
      throw validation('Do not use your name or phone number in your password.', { password: 'Do not use your name or phone number.' });
    }
  }
}
