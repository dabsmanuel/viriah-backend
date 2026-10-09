import { asPlatform, forSchool } from '../core/context';
import { logger } from '../core/logger';
import { registerJob } from '../jobs/queue';
import { daysFromNow, diffDays, todayLagos } from '../lib/dates';
import { files } from '../integrations/storage';
import { Application, AuditLog, ExportJob, Guardian, Membership, MessageLog, School, Student, StudentGuardian } from '../models';
import { notify } from './notify';

/**
 * Retention (Document 3, section 13.2). Suggested periods, confirmed with a data protection adviser before launch:
 * one-time codes and expired sessions are removed by the database (TTL indexes); unsuccessful and withdrawn applications within
 * days; message logs and audit logs on a schedule; expired exports are deleted. Student records and financial records stay.
 */
export const RETENTION = {
  draftApplicationDays: 30,
  closedApplicationDays: 30,
  messageLogMonths: 12,
  auditLogMonths: 12
};

const monthsAgo = (m: number) => new Date(Date.now() - m * 30.5 * 86_400_000);

registerJob('cleanup', async () => {
  const out = { drafts: 0, applications: 0, exports: 0, messageLogs: 0, auditLogs: 0, parentAccessEnded: 0 };

  // Per school work
  const schools: any[] = await asPlatform(() => School.find({ status: { $in: ['active', 'suspended'] } }).select('_id slug name settings').lean());
  for (const s of schools) {
    const schoolId = String(s._id);
    await forSchool(schoolId, async () => {
        // applications that never finished, and ones that ended without an enrolment, are removed within days
        const d1 = await Application.deleteMany({ status: 'draft', updatedAt: { $lt: new Date(Date.now() - RETENTION.draftApplicationDays * 86_400_000) } });
        out.drafts += d1.deletedCount;
        const d2 = await Application.deleteMany({ status: { $in: ['rejected', 'withdrawn', 'expired'] }, updatedAt: { $lt: new Date(Date.now() - RETENTION.closedApplicationDays * 86_400_000) }, studentId: { $exists: false } });
        out.applications += d2.deletedCount;

        // expired exports: the file and the record's link
        const expired: any[] = await ExportJob.find({ status: 'ready', expiresAt: { $lt: new Date() } });
        for (const e of expired) {
          await files.remove(e.file).catch(() => undefined);
          e.status = 'expired';
          e.file = undefined;
          await e.save();
          out.exports += 1;
        }

        // "If the parent has no other active child in the school, the school can end that parent's access after a set period."
        const days = s.settings?.parentAccessEndsAfterDays ?? 0;
        if (days > 0) {
          const guardians: any[] = await Guardian.find({ userId: { $exists: true } }).select('userId').lean();
          for (const g of guardians) {
            const links: any[] = await StudentGuardian.find({ guardianId: g._id }).select('studentId').lean();
            if (!links.length) continue;
            const kids: any[] = await Student.find({ _id: { $in: links.map((l) => l.studentId) } }).select('status statusHistory').lean();
            if (kids.some((k) => k.status === 'active' || k.status === 'suspended')) continue;
            const lastLeft = Math.max(...kids.map((k) => new Date((k.statusHistory ?? []).slice(-1)[0]?.at ?? 0).getTime()));
            if (lastLeft && diffDays(todayLagos(), new Date(lastLeft).toISOString().slice(0, 10)) >= days) {
              const res = await asPlatform(() => Membership.updateOne({ userId: g.userId, schoolId, kind: 'guardian', status: 'active' }, { status: 'deactivated', $inc: { permVersion: 1 } }));
              if (res.modifiedCount) {
                out.parentAccessEnded += 1;
                await notify({ schoolId, event: 'parent_access_ended', to: [{ userId: String(g.userId), kind: 'parent' }], vars: { school: s.name } });
              }
            }
          }
        }
    });
  }

  // Platform-wide logs. Audit records have no update or delete path in the application: this job removes
  // only records past the retention period, directly in the database.
  const ml = await asPlatform(() => MessageLog.deleteMany({ createdAt: { $lt: monthsAgo(RETENTION.messageLogMonths) } }));
  out.messageLogs = ml.deletedCount;
  const al = await AuditLog.collection.deleteMany({ at: { $lt: monthsAgo(RETENTION.auditLogMonths) } });
  out.auditLogs = al.deletedCount;
  logger.info(out, 'retention cleanup');
  return out;
});

export { daysFromNow };
