import type { ClientSession } from 'mongoose';
import { Counter } from '../models';
import { yy } from '../lib/dates';

/** Sequence numbers (receipt, invoice, admission, application) come from the counters collection by atomic increment. */
export async function nextSeq(key: string, session?: ClientSession): Promise<number> {
  const doc = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, new: true, session });
  return doc!.seq;
}

/**
 * Admission number format tokens: {YY} two digit year, {YYYY} four digit year, {SEQ:n} zero padded sequence.
 * Example: "GFS/{YY}/{SEQ:4}" gives GFS/26/0042.
 */
export function formatNumber(format: string, seq: number, at: Date = new Date()): string {
  return format
    .replace(/\{YYYY\}/g, `20${yy(at)}`)
    .replace(/\{YY\}/g, yy(at))
    .replace(/\{SEQ(?::(\d+))?\}/g, (_m, n) => String(seq).padStart(Number(n ?? 4), '0'));
}

export const seqKeyFor = (format: string, kind: string, at: Date = new Date()) => (/\{YY(YY)?\}/.test(format) ? `${kind}:${yy(at)}` : kind);

/** Receipt number: the school's receiptPrefix, a two digit year and a six digit sequence, for example GFS/26/000431. */
export async function nextReceiptNumber(prefix: string, session?: ClientSession, at = new Date()): Promise<string> {
  const seq = await nextSeq(`receipt:${yy(at)}`, session);
  return `${prefix}/${yy(at)}/${String(seq).padStart(6, '0')}`;
}

export async function nextInvoiceNumber(session?: ClientSession, at = new Date()): Promise<string> {
  const seq = await nextSeq(`invoice:${yy(at)}`, session);
  return `INV/${yy(at)}/${String(seq).padStart(6, '0')}`;
}
