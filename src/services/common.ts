import { files } from '../integrations/storage';
import { getCtx } from '../core/context';
import { notFound } from '../core/errors';
import { Membership, PlatformSetting, School } from '../models';
import type { Recipient } from './notify';

export const toStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
export const idList = (xs: unknown[]): string[] => xs.map((x) => String(x));

/** Await a lookup and turn a miss into 404. A record from another school is a miss, never a leak. */
export async function need(p: PromiseLike<any>, what = 'Record'): Promise<any> {
  const v = await p;
  if (!v) throw notFound(what);
  return v;
}

export const pickDefined = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export async function loadSchool(id?: string) {
  const sid = id ?? getCtx()?.schoolId;
  if (!sid) throw new Error('No school in context');
  return need(School.findById(sid).lean(), 'School');
}

let settingsCache: { at: number; value: any } | undefined;
export const clearSettingsCache = () => (settingsCache = undefined);

/** The single platform settings document. Cached for a few seconds. */
export async function platformSettings() {
  if (settingsCache && Date.now() - settingsCache.at < 5000) return settingsCache.value;
  const doc = (await PlatformSetting.findOne({ key: 'platform' }).lean()) ?? (await PlatformSetting.create({ key: 'platform' })).toObject();
  settingsCache = { at: Date.now(), value: doc };
  return doc;
}

export async function staffRecipients(schoolId: string, roles: string[], kind: Recipient['kind'] = 'staff'): Promise<Recipient[]> {
  const ms = await Membership.find({ schoolId, kind: 'staff', roles: { $in: roles }, status: 'active' }).select('userId').lean();
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const m of ms) {
    const id = String(m.userId);
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ userId: id, kind });
    }
  }
  return out;
}

export const ownerRecipients = (schoolId: string) => staffRecipients(schoolId, ['owner'], 'owner');
export const adminRecipients = (schoolId: string) => staffRecipients(schoolId, ['school_admin', 'owner'], 'admin');

/** "Chika Okafor" from a record with first and last name. */
export const fullName = (p?: { firstName?: string; middleName?: string; lastName?: string } | null) => [p?.firstName, p?.lastName].filter(Boolean).join(' ');

export const escapeText = (s: string) => s.replace(/[<>]/g, '');

/** A link, good for an hour, to a stored private picture or document. Only built for rows the caller may already see. */
export const photoUrl = (ref?: string | null) => (ref ? files.link(ref, 3600) : undefined);
export const fileUrl = photoUrl;
