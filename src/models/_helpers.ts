import { Schema } from 'mongoose';

export const OID = Schema.Types.ObjectId;
export const Mixed = Schema.Types.Mixed;
export const ref = (model: string, extra: Record<string, unknown> = {}) => ({ type: OID, ref: model, ...extra });
export const str = (extra: Record<string, unknown> = {}) => ({ type: String, trim: true, ...extra });
export const kobo = (extra: Record<string, unknown> = {}) => ({
  type: Number,
  default: 0,
  validate: { validator: Number.isSafeInteger, message: 'Money must be a whole number of kobo' },
  ...extra
});
export const enumStr = (values: readonly string[], def?: string) => ({ type: String, enum: values as string[], ...(def ? { default: def } : {}) });
/** A date with no time is stored as a YYYY-MM-DD string to avoid time zone shifts. */
export const dateStr = (extra: Record<string, unknown> = {}) => ({
  type: String,
  match: /^\d{4}-\d{2}-\d{2}$/,
  ...extra
});
