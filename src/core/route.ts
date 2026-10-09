import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { forSchool, getCtx } from './context';
import { authenticate, type AuthRouteOpts } from './auth';
import { AppError, notFound, validation } from './errors';
import { idempotency } from './idempotency';
import { rateLimit } from './rateLimit';
import { resolveHost } from './host';
import { Reply, type Handler } from './http';
import { zodFields } from './validate';
import type { PermissionKey } from './permissions';
import { School } from '../models';

/**
 * Every endpoint is declared through this helper so that:
 *  - the access rule is stated next to the path (public, any signed-in user, or a permission key),
 *  - input is validated with a strict schema before the handler runs,
 *  - the route table is known, which lets the tenancy test walk every route (Document 5, M1 criterion 9).
 */

export type Access = 'public' | 'any' | 'webhook' | { perm: PermissionKey | PermissionKey[] };

export interface RouteOpts {
  access: Access;
  /** public route that takes the school from the host name */
  host?: boolean;
  /** public write that needs an active school */
  activeSchool?: boolean;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  idem?: boolean;
  rate?: { name: string; windowMs: number; max: number };
  fresh?: boolean;
  requireActive?: boolean;
  inactiveOk?: boolean;
  allowNoMembership?: boolean;
  allowTempPassword?: boolean;
  summary?: string;
}

export interface RouteMeta {
  method: string;
  path: string; // full path including /api/v1
  scope: 'platform' | 'tenant' | 'public' | 'webhook';
  access: string;
  host: boolean;
  summary?: string;
  hasIdParams: boolean;
}

export const API_PREFIX = '/api/v1';
export const routeRegistry: RouteMeta[] = [];

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export function createRoutes(prefix = '') {
  const router = Router();

  const add = (method: Method) => (path: string, opts: RouteOpts, handler: Handler) => {
    const full = `${API_PREFIX}${prefix}${path}`;
    const isPlatform = `${prefix}${path}`.startsWith('/platform');
    const scope: RouteMeta['scope'] = opts.access === 'webhook' ? 'webhook' : opts.access === 'public' ? 'public' : isPlatform ? 'platform' : 'tenant';
    routeRegistry.push({
      method: method.toUpperCase(),
      path: full,
      scope,
      access: typeof opts.access === 'string' ? opts.access : [].concat(opts.access.perm as never).join('|'),
      host: !!opts.host,
      summary: opts.summary,
      hasIdParams: /:/.test(path)
    });

    const chain: RequestHandler[] = [];

    if (opts.rate) chain.push(rateLimit(opts.rate.name, opts.rate.windowMs, opts.rate.max));

    // ---- access
    chain.push(async (req, _res, next) => {
      try {
        const hostInfo = await resolveHost(req);
        (req as any).hostInfo = hostInfo;
        const ctx = getCtx()!;

        if (opts.access === 'webhook') return next();

        if (opts.access === 'public') {
          if (opts.host) {
            if (hostInfo.kind !== 'school' || !hostInfo.schoolId) throw notFound('School');
            ctx.schoolId = hostInfo.schoolId;
            ctx.platform = false;
            if (opts.activeSchool) {
              const s = await School.findById(hostInfo.schoolId).select('status').lean();
              if (!s || s.status !== 'active') throw new AppError('school_not_active', 'This school is not accepting submissions right now.');
            }
          }
          return next();
        }

        const aopts: AuthRouteOpts = {
          scope: scope === 'platform' ? 'platform' : 'tenant',
          perm: opts.access === 'any' ? 'any' : opts.access.perm,
          allowNoMembership: opts.allowNoMembership,
          allowTempPassword: opts.allowTempPassword,
          inactiveOk: opts.inactiveOk,
          requireActive: opts.requireActive,
          fresh: opts.fresh
        };
        await authenticate(req, hostInfo, aopts);
        next();
      } catch (e) {
        next(e);
      }
    });

    // ---- validation
    chain.push((req, _res, next) => {
      try {
        if (opts.params) {
          const r = opts.params.safeParse(req.params);
          if (!r.success) throw new AppError('not_found', 'Record was not found.'); // a malformed ID is the same as a missing one
          req.params = r.data;
        }
        if (opts.query) {
          const r = opts.query.safeParse(req.query);
          if (!r.success) throw new AppError('validation_failed', 'Some fields need attention.', { fields: zodFields(r.error) });
          Object.defineProperty(req, 'query', { value: r.data, writable: true, configurable: true });
        }
        if (opts.body) {
          const r = opts.body.safeParse(req.body ?? {});
          if (!r.success) throw new AppError('validation_failed', 'Some fields need attention.', { fields: zodFields(r.error) });
          req.body = r.data;
        } else if (method !== 'get' && opts.access !== 'webhook' && req.body && Object.keys(req.body).length) {
          throw validation('This endpoint takes no body.');
        }
        next();
      } catch (e) {
        next(e);
      }
    });

    if (opts.idem) chain.push(idempotency(`${method.toUpperCase()} ${full}`));

    const wrapped = async (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = await handler(req);
        if (out === undefined) return void res.status(204).end();
        send(res, out);
      } catch (e) {
        next(e);
      }
    };

    (router as any)[method](`${prefix}${path}`, ...chain, wrapped);
  };

  return { router, get: add('get'), post: add('post'), put: add('put'), patch: add('patch'), delete: add('delete') };
}

export function send(res: Response, out: Reply) {
  if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  for (const c of out.clearCookies ?? []) res.clearCookie(c.name, c.options);
  for (const c of out.cookies ?? []) res.cookie(c.name, c.value, c.options);
  if (out.status === 204 || out.body === undefined) return void res.status(out.status).end();
  res.status(out.status).json(out.body);
}

/** Helper for modules that need to run public code as a school without the route helper. */
export const asHostSchool = forSchool;
