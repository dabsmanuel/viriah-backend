import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { env, isProd } from '../config/env';
import { getCtx } from './context';
import { AppError, forbidden, unauthenticated } from './errors';
import { permissionsForRoles, supportPermissions, SUPPORT_BLOCKED, type PermissionKey } from './permissions';
import { AuthSession, Membership, School, User } from '../models';
import type { HostInfo } from './host';

export const ACCESS_COOKIE = 'vr_at';
export const REFRESH_COOKIE = 'vr_rt';
export const ACCESS_TTL_MIN = 15;
export const SUPPORT_TTL_MIN = 60;
export const REFRESH_TTL_DAYS = 30;

export interface AccessClaims {
  sub: string; // user id
  ses: string; // auth session id
  mid?: string; // membership id
  sid?: string; // school id
  roles: string[];
  pv?: number; // permissions version
  sup?: boolean; // support flag
  typ: 'access';
}

export function signAccess(claims: Omit<AccessClaims, 'typ'>): string {
  const support = !!claims.sup;
  return jwt.sign({ ...claims, typ: 'access' }, support ? env.JWT_SUPPORT_SECRET : env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${support ? SUPPORT_TTL_MIN : ACCESS_TTL_MIN}m`
  });
}

export function verifyAccess(token: string): AccessClaims {
  try {
    const unverified = jwt.decode(token) as Partial<AccessClaims> | null;
    const secret = unverified?.sup ? env.JWT_SUPPORT_SECRET : env.JWT_ACCESS_SECRET;
    const claims = jwt.verify(token, secret, { algorithms: ['HS256'] }) as AccessClaims;
    if (claims.typ !== 'access') throw new Error('wrong token type');
    return claims;
  } catch {
    throw unauthenticated('Your session has ended. Sign in again.');
  }
}

export const cookieBase = () => ({ httpOnly: true, secure: isProd || env.APP_ENV === 'staging', sameSite: 'lax' as const });

export const accessCookie = (token: string, support = false) => ({
  name: ACCESS_COOKIE,
  value: token,
  options: { ...cookieBase(), path: '/', maxAge: (support ? SUPPORT_TTL_MIN : ACCESS_TTL_MIN) * 60_000 }
});
export const refreshCookie = (token: string) => ({
  name: REFRESH_COOKIE,
  value: token,
  options: { ...cookieBase(), path: '/api/v1/auth', maxAge: REFRESH_TTL_DAYS * 86_400_000 }
});

export function tokenFromRequest(req: Request): string | undefined {
  const c = (req as any).cookies?.[ACCESS_COOKIE];
  if (c) return c;
  const h = req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export interface AuthRouteOpts {
  scope: 'platform' | 'tenant';
  perm?: PermissionKey | PermissionKey[] | 'any';
  /** a session with no membership yet (just signed in, must choose a school) may call this route */
  allowNoMembership?: boolean;
  /** allowed while a temporary password is still in force (change password, me, logout) */
  allowTempPassword?: boolean;
  /** allowed while the school is suspended (sign out, password change) */
  inactiveOk?: boolean;
  /** the school must be active, not just pending (publish the website, send parent logins) */
  requireActive?: boolean;
  /** re-enter the password if the session was confirmed more than 30 minutes ago */
  fresh?: boolean;
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FRESH_MINUTES = 30;

/** Platform roles beyond the super admin are P2. Their permissions are a subset of the platform keys. */
export const PLATFORM_ROLE_PERMS: Record<string, PermissionKey[]> = {
  support: ['platform.metrics.view', 'platform.audit.view', 'platform.support.access', 'platform.jobs.manage'],
  finance: ['platform.metrics.view', 'platform.payments.view']
};

export async function authenticate(req: Request, hostInfo: HostInfo | undefined, opts: AuthRouteOpts): Promise<void> {
  const ctx = getCtx();
  if (!ctx) throw new Error('No request context');
  const token = tokenFromRequest(req);
  if (!token) throw unauthenticated();
  const claims = verifyAccess(token);

  const session = await AuthSession.findById(claims.ses).select('revokedAt expiresAt lastConfirmedAt userId schoolId membershipId').lean();
  if (!session || session.revokedAt || session.expiresAt < new Date() || String(session.userId) !== claims.sub) {
    throw unauthenticated('Your session has ended. Sign in again.');
  }
  const user = await User.findById(claims.sub).select('firstName lastName status platformRole mustChangePassword phone').lean();
  if (!user || user.status !== 'active') throw unauthenticated('This account is not active.');

  ctx.userId = String(user._id);
  ctx.sessionId = claims.ses;
  ctx.lastConfirmedAt = session.lastConfirmedAt;
  ctx.mustChangePassword = !!user.mustChangePassword;
  ctx.displayName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  ctx.support = false;

  if (user.mustChangePassword && !opts.allowTempPassword) {
    throw new AppError('forbidden', 'Change your temporary password before doing anything else.', { details: { mustChangePassword: true } });
  }

  // ---------------------------------------------------------------- platform scope (super admin console)
  if (opts.scope === 'platform') {
    if (!user.platformRole || claims.mid) throw forbidden();
    ctx.platform = true;
    ctx.schoolId = undefined;
    ctx.kind = 'platform';
    ctx.roles = [user.platformRole === 'super_admin' ? 'super_admin' : `platform_${user.platformRole}`];
    ctx.permissions = new Set<string>(user.platformRole === 'super_admin' ? permissionsForRoles(['super_admin']) : PLATFORM_ROLE_PERMS[user.platformRole] ?? []);
    ctx.permissions.add('notifications.own');
    ctx.permissions.add('dashboard.view');
    checkPerm(opts.perm);
    if (opts.fresh) checkFresh(ctx.lastConfirmedAt);
    return;
  }

  // ---------------------------------------------------------------- platform user on a tenant route (no membership)
  ctx.platform = false;
  ctx.kind = undefined;

  // Support session: the super admin acting inside one school.
  if (claims.sup) {
    if (!claims.sid || !user.platformRole) throw unauthenticated();
    const school = await School.findById(claims.sid).select('status').lean();
    if (!school) throw unauthenticated();
    if (hostInfo?.kind === 'school' && hostInfo.schoolId !== claims.sid) throw unauthenticated();
    ctx.schoolId = claims.sid;
    ctx.schoolStatus = school.status;
    ctx.support = true;
    ctx.roles = ['owner'];
    ctx.kind = 'staff';
    ctx.permissions = supportPermissions();
    ctx.permissions.add('notifications.own');
    // Writes in a suspended school are still blocked; support only reads there.
    gateSchoolStatus(req, opts, school.status);
    checkPerm(opts.perm);
    return;
  }

  if (!claims.mid) {
    if (!opts.allowNoMembership) throw forbidden('Choose a school first.');
    ctx.schoolId = undefined;
    ctx.roles = [];
    ctx.permissions = new Set(['notifications.own']);
    return;
  }

  const membership = await Membership.findById(claims.mid).lean();
  if (!membership || String(membership.userId) !== claims.sub || membership.status !== 'active') throw unauthenticated('Your access to this school has ended.');
  if (claims.pv !== undefined && membership.permVersion !== claims.pv) throw unauthenticated('Your access changed. Refreshing your session.');
  if (hostInfo?.kind === 'school' && hostInfo.schoolId !== String(membership.schoolId)) throw unauthenticated();

  const school = await School.findById(membership.schoolId).select('status').lean();
  if (!school) throw unauthenticated();

  ctx.membershipId = String(membership._id);
  ctx.schoolId = String(membership.schoolId);
  ctx.schoolStatus = school.status;
  ctx.kind = membership.kind as Ctx['kind'];
  ctx.staffId = membership.staffId ? String(membership.staffId) : undefined;
  ctx.guardianId = membership.guardianId ? String(membership.guardianId) : undefined;
  ctx.studentId = membership.studentId ? String(membership.studentId) : undefined;
  ctx.roles = membership.kind === 'guardian' ? ['parent'] : membership.kind === 'student' ? ['student'] : membership.roles;
  ctx.permissions = permissionsForRoles(ctx.roles, membership.extraPermissions);

  gateSchoolStatus(req, opts, school.status);
  checkPerm(opts.perm);
  if (opts.fresh) checkFresh(ctx.lastConfirmedAt);
}

type Ctx = NonNullable<ReturnType<typeof getCtx>>;

/**
 * A pending school can sign in and use the setup checklist but cannot publish or send parent logins (route.requireActive).
 * A suspended, rejected or closed school is read only: every change returns school_not_active.
 */
function gateSchoolStatus(req: Request, opts: AuthRouteOpts, status: string) {
  if (opts.inactiveOk) return;
  if (WRITE.has(req.method) && ['suspended', 'rejected', 'closed'].includes(status)) {
    throw new AppError('school_not_active', status === 'suspended' ? 'This school is suspended. You can read records but not change them.' : 'This school is not active.');
  }
  if (opts.requireActive && status !== 'active') {
    throw new AppError('school_not_active', status === 'pending' ? 'This school is waiting for approval. This action opens when it is approved.' : 'This school is not active.');
  }
}

function checkPerm(perm: AuthRouteOpts['perm']) {
  if (!perm || perm === 'any') return;
  const ctx = getCtx()!;
  const keys = Array.isArray(perm) ? perm : [perm];
  const held = keys.find((k) => ctx.permissions.has(k));
  if (held) return;
  // A support session refuses a fixed list of keys with its own code.
  if (ctx.support && keys.some((k) => SUPPORT_BLOCKED.has(k))) {
    throw new AppError('support_blocked', 'This action is not allowed in a support session.');
  }
  throw forbidden();
}

function checkFresh(confirmedAt?: Date) {
  if (!confirmedAt || Date.now() - confirmedAt.getTime() > FRESH_MINUTES * 60_000) {
    throw new AppError('unauthenticated', 'Enter your password to continue with this action.', { details: { reauth: true } });
  }
}

/**
 * Optional sign-in for public routes that behave a little differently for a signed-in user (the payment return page).
 * Any failure leaves the request anonymous.
 */
export async function softAuthenticate(req: Request, hostInfo: HostInfo | undefined): Promise<boolean> {
  const ctx = getCtx();
  if (!ctx || !tokenFromRequest(req)) return false;
  const snapshot = { ...ctx, permissions: new Set(ctx.permissions), roles: [...ctx.roles] };
  const schoolBefore = ctx.schoolId;
  try {
    await authenticate(req, hostInfo, { scope: 'tenant', perm: 'any', inactiveOk: true, allowTempPassword: true });
    if (schoolBefore && ctx.schoolId !== schoolBefore) throw new Error('other school');
    return true;
  } catch {
    Object.assign(ctx, snapshot);
    ctx.userId = undefined;
    ctx.guardianId = undefined;
    ctx.roles = [];
    ctx.permissions = new Set();
    return false;
  }
}
