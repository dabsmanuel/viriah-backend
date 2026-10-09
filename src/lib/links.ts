import { env } from '../config/env';

/**
 * Links sent in SMS and email. Each school has one address, for example greenfield.yourplatform.ng.
 * The public website is at that address and the portal is at /portal. In development the web app runs on
 * localhost, so a school lives at {slug}.localhost:3000.
 */
export function schoolOrigin(slug: string): string {
  if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') return `https://${slug}.${env.PLATFORM_DOMAIN}`;
  const u = new URL(env.WEB_ORIGIN);
  return `${u.protocol}//${slug}.localhost${u.port ? `:${u.port}` : ''}`;
}

export const schoolLink = (slug: string, path = '/') => `${schoolOrigin(slug)}${path}`;
export const portalLink = (slug: string, path = '') => `${schoolOrigin(slug)}/portal${path}`;

/** Platform site and the super admin console. */
export function platformOrigin(): string {
  return env.APP_ENV === 'production' || env.APP_ENV === 'staging' ? `https://${env.PLATFORM_DOMAIN}` : env.WEB_ORIGIN;
}
