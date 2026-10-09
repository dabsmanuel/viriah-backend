import { z, ZodError, type ZodTypeAny } from 'zod';
import { AppError } from './errors';
import { normalizePhone } from '../lib/phone';
import { isDateString } from '../lib/dates';
import { Types } from 'mongoose';

/** Zod issues become { "cells[2].score": "Exam is marked out of 60." } (API 1.4). */
export function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    let key = '';
    for (const p of issue.path) key += typeof p === 'number' ? `[${p}]` : key ? `.${p}` : String(p);
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) fields[key ? `${key}.${k}` : k] = 'This field is not accepted.';
      continue;
    }
    fields[key || '_'] ??= issue.message;
  }
  return fields;
}

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('validation_failed', 'Some fields need attention.', { fields: zodFields(r.error) });
  return r.data;
}

// ------------------------------------------------------------------ shared field types

export const objectId = z.string().refine((v) => Types.ObjectId.isValid(v) && String(new Types.ObjectId(v)) === v, 'Not a valid ID.');
export const phone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const p = normalizePhone(v);
    if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number.' });
    return p ?? '';
  });
export const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
export const dateStr = z.string().refine(isDateString, 'Use the format YYYY-MM-DD.');
export const kobo = z.number().int('Money must be a whole number of kobo.').nonnegative('Money cannot be negative.').max(100_000_000_000_00);
export const text = (max = 500) => z.string().trim().max(max);
export const name = (max = 80) => z.string().trim().min(1, 'This field is required.').max(max);
export const password = z.string().min(8, 'Use at least 8 characters.').max(128);
export const code6 = z.string().regex(/^\d{6}$/, 'Enter the 6 digit code.');
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{2,39}$/, 'Use 3 to 40 lowercase letters, digits or hyphens, starting with a letter.');
export const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1d4ed8.');
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().trim().max(50).optional(),
  format: z.enum(['xlsx', 'csv']).optional()
};
export const idParam = z.object({ id: objectId }).strict();

/** An optional ID that may be sent as an empty string or null from a form. */
export const optId = z.preprocess((v) => (v === '' || v === null ? undefined : v), objectId.optional());
export const boolish = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

export { z };
