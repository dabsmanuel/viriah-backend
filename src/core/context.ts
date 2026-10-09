import { AsyncLocalStorage } from 'node:async_hooks';
import type { Types } from 'mongoose';

/**
 * Request context kept in AsyncLocalStorage for the life of a request or job.
 * The tenancy plugin reads schoolId from here. Nothing else may choose the school.
 */
export interface Ctx {
  requestId?: string;
  userId?: string;
  membershipId?: string;
  schoolId?: string;
  roles: string[];
  permissions: Set<string>;
  support?: boolean;
  platform?: boolean; // set by asPlatform(): tenant scoping is skipped
  ip?: string;
  userAgent?: string;
  // staff / guardian / student record ids of the signed-in membership
  staffId?: string;
  guardianId?: string;
  studentId?: string;
  kind?: 'staff' | 'guardian' | 'student' | 'platform';
  sessionId?: string;
  schoolStatus?: string;
  mustChangePassword?: boolean;
  lastConfirmedAt?: Date;
  displayName?: string;
}

const storage = new AsyncLocalStorage<Ctx>();

export const emptyCtx = (): Ctx => ({ roles: [], permissions: new Set() });

export const getCtx = (): Ctx | undefined => storage.getStore();

export const runWithCtx = <T>(ctx: Ctx, fn: () => T): T => storage.run(ctx, fn);

/** Mutate the current context (used by the auth middleware after it has run inside the request scope). */
export const patchCtx = (patch: Partial<Ctx>) => {
  const c = storage.getStore();
  if (c) Object.assign(c, patch);
};

/**
 * Run platform-level code (super admin console, cross-school jobs). Easy to search for in review.
 *
 * The callback is awaited inside the scope on purpose: a Mongoose query is lazy, so returning one un-awaited would
 * run its tenant hooks later, outside this context.
 */
export const asPlatform = <T>(fn: () => T | PromiseLike<T>): Promise<Awaited<T>> => {
  const parent = storage.getStore() ?? emptyCtx();
  return storage.run({ ...parent, platform: true }, async () => (await fn()) as any);
};

/** Run code as one school. Used by public requests (school from host) and background jobs. Awaited inside the scope, as above. */
export const forSchool = <T>(schoolId: string | Types.ObjectId, fn: () => T | PromiseLike<T>): Promise<Awaited<T>> => {
  const parent = storage.getStore() ?? emptyCtx();
  return storage.run({ ...parent, platform: false, schoolId: String(schoolId) }, async () => (await fn()) as any);
};

export const currentSchoolId = (): string | undefined => storage.getStore()?.schoolId;

export const requireSchoolId = (): string => {
  const id = storage.getStore()?.schoolId;
  if (!id) throw new Error('No school in context. Wrap this work in forSchool(id) or asPlatform().');
  return id;
};
