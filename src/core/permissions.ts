/**
 * Permission keys follow area.object.action (Document 3, section 6.4).
 * One table maps each key to the roles that hold it. Route middleware checks keys, never role names.
 * Reach (which records) is enforced separately in the service layer.
 */

export const ROLES = [
  'super_admin',
  'owner',
  'principal',
  'school_admin',
  'bursar',
  'class_teacher',
  'subject_teacher',
  'parent',
  'student'
] as const;
export type Role = (typeof ROLES)[number];

export const STAFF_ROLES: Role[] = ['owner', 'principal', 'school_admin', 'bursar', 'class_teacher', 'subject_teacher'];
export const SCHOOL_ROLES: Role[] = [...STAFF_ROLES, 'parent', 'student'];
/** Roles a school admin may NOT assign (Document 2 matrix: admin cannot assign owner or principal). */
export const ADMIN_FORBIDDEN_ROLES: Role[] = ['owner', 'principal', 'super_admin'];

const SHORT: Record<string, Role> = {
  SA: 'super_admin',
  OW: 'owner',
  PR: 'principal',
  AD: 'school_admin',
  BU: 'bursar',
  CT: 'class_teacher',
  ST: 'subject_teacher',
  PA: 'parent',
  SU: 'student'
};

const STAFF = 'OW PR AD BU CT ST';
const ALL = 'OW PR AD BU CT ST PA SU';

// prettier-ignore
const TABLE = {
  // ---- Platform (super admin only)
  'platform.schools.manage': 'SA',
  'platform.template.manage': 'SA',
  'platform.presets.manage': 'SA',
  'platform.sites.manage': 'SA',
  'platform.metrics.view': 'SA',
  'platform.settings.manage': 'SA',
  'platform.support.access': 'SA',
  'platform.audit.view': 'SA',
  'platform.payments.view': 'SA',
  'platform.jobs.manage': 'SA',

  // ---- School setup
  'school.profile.view': STAFF,
  'school.profile.manage': 'OW AD',
  'school.branding.manage': 'OW AD',
  'school.setup.manage': 'OW AD',
  'school.golive': 'OW AD',
  'school.audit.view': 'OW PR',
  'school.export.request': 'OW',
  'staff.view': 'OW PR AD',
  'staff.manage': 'OW AD',
  'staff.roles.manage': 'OW AD',
  'academics.view': STAFF,
  'academics.manage': 'OW PR AD',
  'academics.assign.manage': 'OW PR AD',
  'academics.assign.view': 'OW PR AD CT ST',
  'terms.state.manage': 'OW PR',
  'studentlogin.policy.manage': 'OW PR AD',
  'website.view': 'OW PR AD',
  'website.manage': 'OW AD',
  'website.publish': 'OW AD',
  'enquiries.view': 'OW PR AD',
  'enquiries.manage': 'OW AD',

  // ---- Admissions and student records
  'admissions.settings.manage': 'OW PR AD',
  'admissions.review': 'OW PR AD BU',
  'admissions.decide': 'OW PR AD',
  'admissions.enrol': 'OW PR AD',
  'students.list.view': STAFF,
  'students.profile.view': ALL,
  'students.profile.manage': 'OW PR AD',
  'students.medical.view': 'OW PR AD CT PA',
  'students.guardians.view': 'OW PR AD BU CT PA',
  'students.guardians.manage': 'OW PR AD',
  'students.status.manage': 'OW PR AD',
  'students.documents.view': 'OW PR AD CT PA',
  'students.documents.manage': 'OW PR AD',
  'students.subjects.view': 'OW PR AD BU CT ST PA SU',
  'students.subjects.manage': 'OW PR AD CT',
  'students.move': 'OW PR AD',
  'imports.manage': 'OW PR AD BU',
  'imports.rollback': 'OW PR',
  'legacy.results.manage': 'OW PR AD',
  'contact.change.request': 'PA SU',
  'contact.change.decide': 'OW PR AD',

  // ---- Teaching, attendance, results
  'tasks.manage': 'CT ST',
  'tasks.view': 'OW PR CT ST',
  'tasks.submit': 'PA SU',
  'attendance.take': 'CT',
  'attendance.view': 'OW PR AD CT PA SU',
  'attendance.unlock': 'OW PR',
  'attendance.days.manage': 'OW PR AD',
  'scores.view': 'OW PR CT ST',
  'scores.enter': 'CT ST',
  'scores.submit': 'CT ST',
  'scores.return': 'CT PR OW',
  'results.ratings.manage': 'CT',
  'results.comments.manage': 'CT PR OW',
  'results.compile': 'CT PR',
  'results.submit': 'CT',
  'results.approve': 'OW PR',
  'results.publish': 'OW PR',
  'results.reopen': 'OW PR',
  'results.class.view': 'OW PR CT',
  'results.broadsheet': 'OW PR CT',
  'results.published.view': 'OW PR AD CT ST PA SU',
  'results.unblock': 'OW PR BU',
  'promotion.rules.manage': 'OW PR',
  'promotion.rules.view': 'OW PR CT',
  'promotion.review': 'CT PR',
  'promotion.approve': 'OW PR',
  'promotion.rollover': 'OW PR',

  // ---- Fees and payments
  'fees.structure.view': 'OW PR AD BU',
  'fees.structure.manage': 'OW BU',
  'fees.invoice.manage': 'OW BU',
  'fees.invoice.view': 'OW BU',
  'fees.discount.request': 'OW BU',
  'fees.discount.approve': 'OW',
  'fees.payment.record': 'OW BU',
  'fees.payment.confirm_proof': 'OW BU',
  'fees.payment.view': 'OW BU',
  'fees.refund.request': 'OW BU',
  'fees.refund.approve': 'OW',
  'fees.pay': 'PA',
  'fees.own.view': 'PA',
  'fees.status.view': 'OW PR AD BU',
  'fees.reports.view': 'OW BU',
  'fees.bank.view': 'OW BU',
  'fees.bank.manage': 'OW',
  'fees.reminders.manage': 'OW BU',
  'fees.opening.manage': 'OW BU',

  // ---- Communication, reports, oversight
  'comms.announce.school': 'OW PR AD',
  'comms.announce.own': 'CT ST',
  'comms.announce.view': ALL,
  'comms.templates.manage': 'OW AD BU',
  'comms.sms.view': 'OW AD BU',
  'comms.sms.purchase': 'OW BU',
  'comms.log.view': 'OW AD',
  'notifications.own': 'SA ' + ALL,
  'reports.enrolment.view': 'OW PR AD',
  'reports.attendance.view': 'OW PR AD CT',
  'reports.academic.view': 'OW PR CT ST',
  'reports.finance.view': 'OW BU',
  'approvals.view': 'OW PR',
  'dashboard.view': 'SA ' + ALL
} as const;

export type PermissionKey = keyof typeof TABLE;

const roleKeys = new Map<Role, Set<PermissionKey>>();
for (const r of ROLES) roleKeys.set(r, new Set());
for (const [key, who] of Object.entries(TABLE) as [PermissionKey, string][]) {
  for (const code of who.split(' ')) roleKeys.get(SHORT[code])!.add(key);
}

/** Keys the super admin cannot use while in a support session (Document 3, section 6.4; Document 2 flow F21). */
export const SUPPORT_BLOCKED: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'results.approve',
  'results.publish',
  'results.reopen',
  'fees.payment.record',
  'fees.payment.confirm_proof',
  'fees.refund.request',
  'fees.refund.approve',
  'fees.bank.manage',
  'fees.discount.approve',
  'school.export.request'
]);

/** Extras a school may grant one person without inventing a new role (Document 2, section 1.2). */
export const GRANTABLE_EXTRAS: readonly PermissionKey[] = [
  'admissions.review', // for a teacher
  'fees.reports.view', // finance summary view for the principal
  'fees.discount.approve', // discount approval for the principal
  'scores.enter' // score entry on behalf of teachers, for a school admin
];

/** Fee amounts are never visible to teachers. Used by the leak test. */
export const TEACHER_FORBIDDEN_PREFIXES = ['fees.'];

export function permissionsForRoles(roles: readonly string[], extras: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  for (const r of roles) roleKeys.get(r as Role)?.forEach((k) => out.add(k));
  for (const e of extras) if ((GRANTABLE_EXTRAS as readonly string[]).includes(e)) out.add(e);
  return out;
}

/** The permission set used for a support session: everything an owner has, minus the blocked keys. */
export function supportPermissions(): Set<string> {
  const s = permissionsForRoles(['owner']);
  for (const k of SUPPORT_BLOCKED) s.delete(k);
  // Support users never approve or publish and never act as a school's payer.
  return s;
}

export const allPermissionKeys = (): PermissionKey[] => Object.keys(TABLE) as PermissionKey[];
export const rolesHolding = (key: PermissionKey): Role[] => ROLES.filter((r) => roleKeys.get(r)!.has(key));

/** Which role may set which roles on a staff account. */
export function canAssignRole(actorRoles: readonly string[], role: string): boolean {
  if (actorRoles.includes('owner')) return role !== 'super_admin' && role !== 'parent' && role !== 'student';
  if (actorRoles.includes('school_admin')) {
    return !ADMIN_FORBIDDEN_ROLES.includes(role as Role) && STAFF_ROLES.includes(role as Role);
  }
  return false;
}
