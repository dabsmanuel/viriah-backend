import type { Request } from 'express';
import { env, isLocal } from '../config/env';
import { Domain, School } from '../models';

/**
 * Host names and routing (Document 3, section 4).
 *
 *   yourplatform.ng, www.yourplatform.ng      platform site
 *   admin.yourplatform.ng                      super admin console
 *   {slug}.yourplatform.ng                     a school's website and portals
 *   a school's own domain (P2)                 looked up in the domains collection
 *
 * The browser calls /api/... on whatever host it is on. Next.js forwards the request to the API and passes the
 * original host. Session cookies are therefore tied to one school's address.
 */

export const RESERVED_SLUGS = ['www', 'admin', 'api', 'app', 'portal', 'mail', 'support', 'help', 'status', 'docs', 'blog', 'cdn', 'static', 'assets', 'staging', 'dev', 'test', 'demo'];

export interface HostInfo {
  kind: 'platform' | 'admin' | 'school' | 'api';
  host: string;
  slug?: string;
  schoolId?: string;
  schoolStatus?: string;
}

const cache = new Map<string, { at: number; value: HostInfo }>();
const TTL = isLocal ? 0 : 15_000;
export const clearHostCache = () => cache.clear();

const stripPort = (h: string) => h.toLowerCase().replace(/:\d+$/, '');

export async function resolveHost(req: Request): Promise<HostInfo> {
  const raw = (req.header('x-forwarded-host') ?? req.header('host') ?? '').split(',')[0].trim();
  const host = stripPort(raw);
  const root = env.PLATFORM_DOMAIN.toLowerCase();

  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  let info: HostInfo = { kind: 'api', host };
  if (host === root || host === `www.${root}`) info = { kind: 'platform', host };
  else if (host === `admin.${root}`) info = { kind: 'admin', host };
  else if (host === `api.${root}`) info = { kind: 'api', host };
  else if (host.endsWith(`.${root}`)) {
    const slug = host.slice(0, -root.length - 1);
    if (!slug.includes('.')) info = await schoolInfo(host, slug);
  } else if (host && host !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.endsWith('.localhost')) {
    const d = await Domain.findOne({ host, verifiedAt: { $exists: true } }).lean();
    if (d) {
      const s = await School.findById(d.schoolId).select('slug status').lean();
      if (s) info = { kind: 'school', host, slug: s.slug, schoolId: String(s._id), schoolStatus: s.status };
    }
  } else if (host.endsWith('.localhost')) {
    // greenfield.localhost:3000 in development
    const slug = host.slice(0, -'.localhost'.length);
    info = await schoolInfo(host, slug);
  }

  // Development and tests: choose a school by header when there is no school host.
  if (info.kind === 'api' && isLocal) {
    const slug = req.header('x-school-slug');
    if (slug) info = await schoolInfo(host, slug.toLowerCase());
  }

  if (TTL) cache.set(host, { at: Date.now(), value: info });
  return info;
}

async function schoolInfo(host: string, slug: string): Promise<HostInfo> {
  const s = await School.findOne({ slug }).select('slug status').lean();
  if (!s) return { kind: 'api', host };
  return { kind: 'school', host, slug: s.slug, schoolId: String(s._id), schoolStatus: s.status };
}
