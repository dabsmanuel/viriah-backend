import type { Request } from 'express';
import { getCtx, type Ctx } from './context';
import { forbidden, unauthenticated } from './errors';

/** What a handler returns. The route wrapper sends it in the response envelope (API 1.4). */
export class Reply {
  constructor(
    public status: number,
    public body?: unknown,
    public headers?: Record<string, string>,
    public cookies?: Array<{ name: string; value: string; options: Record<string, unknown> }>,
    public clearCookies?: Array<{ name: string; options?: Record<string, unknown> }>
  ) {}

  withCookies(cookies: Reply['cookies'], clear?: Reply['clearCookies']) {
    this.cookies = cookies;
    this.clearCookies = clear;
    return this;
  }
}

export interface Meta {
  page: number;
  limit: number;
  total: number;
}

export const ok = <T>(data: T, meta?: Meta) => new Reply(200, meta ? { data, meta } : { data });
/** A list with paging meta and optional extra top-level fields such as totals. */
export const list = <T>(rows: T[], meta: Meta, extra: Record<string, unknown> = {}) => new Reply(200, { data: rows, meta, ...extra });
export const created = <T>(data: T) => new Reply(201, { data });
export const accepted = (jobId: string, extra: Record<string, unknown> = {}) => new Reply(202, { data: { jobId, ...extra } });
export const noContent = () => new Reply(204);

export type Handler = (req: Request) => Promise<Reply | void> | Reply | void;

/** The signed-in context. Throws if the request is not authenticated. */
export function me(): Ctx & { userId: string } {
  const c = getCtx();
  if (!c?.userId) throw unauthenticated();
  return c as Ctx & { userId: string };
}

/** The school the signed-in user is working in. */
export function mySchool(): string {
  const c = me();
  if (!c.schoolId) throw forbidden('Choose a school first.');
  return c.schoolId;
}

export const can = (key: string) => !!getCtx()?.permissions.has(key);
export const hasRole = (...roles: string[]) => roles.some((r) => getCtx()?.roles.includes(r));

export function requirePerm(key: string) {
  if (!can(key)) throw forbidden();
}
