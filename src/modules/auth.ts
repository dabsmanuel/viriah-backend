import { createRoutes } from '../core/route';
import { z, code6, objectId, password, text } from '../core/validate';
import { noContent, ok, Reply } from '../core/http';
import * as auth from '../services/auth';

const r = createRoutes('/auth');
export const router = r.router;

const loginRate = { name: 'login', windowMs: 15 * 60_000, max: 60 };
const codeRate = { name: 'code', windowMs: 60 * 60_000, max: 30 };

r.post('/login', { access: 'public', rate: loginRate, body: z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) }).strict(), summary: 'Sign in with phone, email or admission number' }, async (req) => auth.login(req.body, req));

r.post('/two-step', { access: 'public', rate: loginRate, body: z.object({ challengeId: objectId, code: z.string().trim().min(6).max(20) }).strict(), summary: 'Complete sign-in with a code' }, async (req) => auth.completeTwoStep(req.body, req));

r.post('/refresh', { access: 'public', rate: { name: 'refresh', windowMs: 60_000, max: 60 }, body: z.object({ refreshToken: z.string().optional() }).strict().optional(), summary: 'Rotate the refresh token' }, async (req) => auth.refresh(req));

const sessionOpts = { allowNoMembership: true, allowTempPassword: true, inactiveOk: true } as const;

r.post('/logout', { access: 'any', ...sessionOpts, summary: 'End this session' }, async () => auth.logout());
r.post('/logout-all', { access: 'any', ...sessionOpts, summary: 'End every session of this user' }, async () => auth.logoutAll());

r.post('/forgot-password', { access: 'public', rate: codeRate, body: z.object({ identifier: z.string().trim().min(1).max(254) }).strict(), summary: 'Send a reset code or link' }, async (req) => {
  await auth.forgotPassword(req.body.identifier, req);
  return ok({ message: 'If there is an account, a code has been sent.' });
});

r.post(
  '/reset-password',
  {
    access: 'public',
    rate: codeRate,
    body: z.object({ identifier: z.string().trim().min(1).max(254).optional(), code: code6.optional(), token: z.string().min(10).max(200).optional(), newPassword: password }).strict(),
    summary: 'Set a new password using the code'
  },
  async (req) => {
    await auth.resetPassword(req.body, req);
    return ok({ ok: true });
  }
);

r.post('/change-password', { access: 'any', ...sessionOpts, body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).strict(), summary: 'Change password while signed in' }, async (req) => auth.changePassword(req.body));

r.post('/accept-invite', { access: 'public', rate: codeRate, body: z.object({ token: z.string().min(10).max(200), password }).strict(), summary: 'Set a password from a staff invite link' }, async (req) => auth.acceptInvite(req.body, req));

r.get('/me', { access: 'any', ...sessionOpts, summary: 'The user, memberships, current school and role, and permission keys' }, async (req) => ok(await auth.currentUser(req)));

r.post('/switch', { access: 'any', allowNoMembership: true, inactiveOk: true, body: z.object({ membershipId: objectId }).strict(), summary: 'Switch to another membership or role' }, async (req) => auth.switchMembership(req.body.membershipId, req));

r.get('/sessions', { access: 'any', ...sessionOpts, summary: 'List active sessions' }, async () => ok(await auth.listSessions()));
r.delete('/sessions/:id', { access: 'any', ...sessionOpts, params: z.object({ id: objectId }).strict(), summary: 'End one session' }, async (req) => {
  await auth.endSession(req.params.id as string);
  return noContent();
});

r.post('/two-step/setup', { access: 'any', ...sessionOpts, body: z.object({ method: z.enum(['totp', 'sms']).default('totp') }).strict(), summary: 'Begin switching on two-step login' }, async (req) => ok(await auth.twoStepSetup(req.body.method)));
r.post('/two-step/confirm', { access: 'any', ...sessionOpts, body: z.object({ code: z.string().trim().min(6).max(8) }).strict(), summary: 'Confirm with a code and receive recovery codes' }, async (req) => ok(await auth.twoStepConfirm(req.body.code)));
r.delete('/two-step', { access: 'any', ...sessionOpts, fresh: true, summary: 'Switch two-step login off (not allowed for the super admin)' }, async () => {
  await auth.twoStepDisable();
  return noContent();
});

r.post('/confirm-password', { access: 'any', ...sessionOpts, body: z.object({ password: z.string().min(1).max(128) }).strict(), summary: 'Re-enter the password before a sensitive action' }, async (req) => {
  await auth.confirmPassword(req.body.password);
  return ok({ ok: true });
});

r.post('/support/exchange', { access: 'public', rate: loginRate, body: z.object({ token: text(2000) }).strict(), summary: 'Exchange a support token for a cookie on the school address' }, async (req) => auth.exchangeSupportToken(req.body.token, req));

export type { Reply };
