import type { ClientSession } from 'mongoose';
import { AuditLog } from '../models';
import { getCtx } from './context';
import { logger } from './logger';

export interface AuditInput {
  action: string; // for example "results.publish", "fees.payment.record"
  entityType?: string;
  entityId?: unknown;
  before?: unknown;
  after?: unknown;
  reason?: string;
  schoolId?: string;
  actorUserId?: string;
  session?: ClientSession;
}

/**
 * Audit records for sensitive actions: logins, role changes, score changes after submission, result publish and reopen,
 * payments, refunds, fee changes, promotion decisions, bank account changes, data exports (AUTH-09).
 * Records are append only. The application has no update or delete path.
 */
export async function audit(a: AuditInput): Promise<void> {
  const ctx = getCtx();
  const doc = {
    schoolId: a.schoolId ?? ctx?.schoolId,
    actorUserId: a.actorUserId ?? ctx?.userId,
    actorRoles: ctx?.roles ?? [],
    supportSession: !!ctx?.support,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId === undefined ? undefined : String(a.entityId),
    before: scrub(a.before),
    after: scrub(a.after),
    reason: a.reason,
    ip: ctx?.ip,
    requestId: ctx?.requestId,
    at: new Date()
  };
  try {
    await AuditLog.create([doc], a.session ? { session: a.session } : {});
  } catch (e) {
    // An audit failure inside a transaction must abort that transaction. Outside, it must be loud.
    if (a.session) throw e;
    logger.error({ err: e, action: a.action }, 'audit write failed');
    throw e;
  }
}

const SECRET_KEYS = /password|secret|token|hash|otp|code$/i;
/** Never store secrets in audit trails. */
function scrub(v: unknown, depth = 0): unknown {
  if (v === undefined || v === null) return v;
  if (depth > 6) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = typeof (v as any).toObject === 'function' ? (v as any).toObject() : v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(val, depth + 1);
    return out;
  }
  return v;
}
