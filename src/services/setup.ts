import { audit } from '../core/audit';
import { asPlatform, getCtx } from '../core/context';
import { AppError } from '../core/errors';
import { me } from '../core/http';
import { schoolLink } from '../lib/links';
import { enqueue, registerJob } from '../jobs/queue';
import {
  AcademicSession,
  AssessmentStructure,
  ClassArm,
  ClassLevel,
  ClassSubject,
  CommentBank,
  Enrolment,
  FeeItem,
  FeeStructure,
  Guardian,
  GradingScale,
  LevelGroup,
  Preset,
  School,
  Site,
  Staff,
  Student,
  StudentGuardian,
  Subject,
  TeachingAssignment,
  Term,
  Trait
} from '../models';
import { ensureGuardianAccount, ensureStudentAccount } from './accounts';
import { loadSchool, fullName } from './common';
import { notify } from './notify';
import { GROUPS, type GroupKey } from '../seed/presets';

/**
 * The guided setup checklist (ONB-05, flow F2). Progress is computed from the data, so it cannot drift:
 * steps can be done in any order, left and resumed.
 *
 * Steps 1 to 6 and 12 are required to publish the website. Steps 1 to 11 are required before parent logins can be sent.
 */

export const STEPS = [
  { key: 'profile', title: 'School profile', n: 1 },
  { key: 'branding', title: 'Logo and colours', n: 2 },
  { key: 'session', title: 'Session and terms', n: 3 },
  { key: 'classes', title: 'Classes and arms', n: 4 },
  { key: 'subjects', title: 'Subjects', n: 5 },
  { key: 'grading', title: 'Grading and assessment', n: 6 },
  { key: 'staff', title: 'Staff', n: 7 },
  { key: 'assignments', title: 'Teacher assignments', n: 8 },
  { key: 'students', title: 'Students', n: 9 },
  { key: 'fees', title: 'Fee structure', n: 10 },
  { key: 'bank', title: 'Bank account', n: 11 },
  { key: 'website', title: 'Website', n: 12 }
] as const;

const WEBSITE_REQUIRED = ['profile', 'branding', 'session', 'classes', 'subjects', 'grading'];
const GO_LIVE_REQUIRED = ['profile', 'branding', 'session', 'classes', 'subjects', 'grading', 'staff', 'assignments', 'students', 'fees', 'bank'];

export async function computeSetupProgress() {
  const schoolId = getCtx()!.schoolId!;
  const school: any = await loadSchool(schoolId);
  const [session, terms, levels, arms, classSubjects, groups, staffCount, assignments, students, currentTerm, feeStructures, site] = await Promise.all([
    AcademicSession.findOne({ status: 'current' }).lean(),
    Term.find({}).lean(),
    ClassLevel.countDocuments({ active: true }),
    ClassArm.countDocuments({ active: true }),
    ClassSubject.countDocuments({}),
    LevelGroup.find({}).lean(),
    Staff.countDocuments({ status: { $ne: 'deactivated' } }),
    TeachingAssignment.countDocuments({}),
    Student.countDocuments({}),
    Term.findOne({ status: 'current' }).lean(),
    FeeStructure.find({}).limit(1).lean(),
    Site.findOne({}).lean()
  ]);
  const usedGroups = new Set((await ClassLevel.find({ active: true }).select('levelGroupId').lean()).map((l: any) => String(l.levelGroupId)));
  const groupsInUse = groups.filter((g: any) => usedGroups.has(String(g._id)));

  const done: Record<string, boolean> = {
    profile: !!(school.name && school.address?.state && school.address?.lga && school.phone && school.email),
    branding: !!(school.branding?.logo && school.branding?.primary && school.branding?.secondary),
    session: !!(session && terms.filter((t: any) => String(t.sessionId) === String(session._id)).length === 3 && currentTerm),
    classes: levels > 0 && arms > 0,
    subjects: classSubjects > 0,
    grading: groupsInUse.length > 0 && groupsInUse.every((g: any) => g.gradingScaleId && g.assessmentStructureId),
    staff: staffCount > 1,
    assignments: assignments > 0,
    students: students > 0,
    fees: !!(currentTerm && feeStructures.length),
    bank: !!school.paystack?.subaccountCode,
    website: site?.status === 'published'
  };

  const steps = STEPS.map((s) => ({
    key: s.key,
    title: s.title,
    n: s.n,
    done: done[s.key],
    requiredFor: [...(WEBSITE_REQUIRED.includes(s.key) || s.key === 'website' ? ['publish_website'] : []), ...(GO_LIVE_REQUIRED.includes(s.key) ? ['go_live'] : [])]
  }));
  const completed = steps.filter((s) => s.done).length;
  const missing = (req: string[]) => steps.filter((s) => req.includes(s.key) && !s.done).map((s) => ({ key: s.key, title: s.title }));
  return {
    steps,
    completed,
    total: steps.length,
    percent: Math.round((completed / steps.length) * 100),
    website: { canPublish: missing(WEBSITE_REQUIRED).length === 0, missing: missing(WEBSITE_REQUIRED) },
    goLive: { canSend: missing(GO_LIVE_REQUIRED).length === 0, missing: missing(GO_LIVE_REQUIRED), liveAt: school.setupProgress?.liveAt ?? null },
    schoolStatus: school.status
  };
}

// ------------------------------------------------------------------ presets

export interface ApplyPresetsInput {
  classLevels: string[] | 'all';
  subjects: boolean;
  grading: boolean;
  traits: boolean;
  feeItems: boolean;
  commentBank: boolean;
}

/** Copy chosen presets (levels, subjects, grading, assessment, traits, fee items) into the school. Idempotent. */
export async function applyPresets(input: ApplyPresetsInput) {
  const presets: any[] = await asPlatform(() => Preset.find({ active: true }).sort({ kind: 1, order: 1 }).lean());
  const of = (kind: string) => presets.filter((p) => p.kind === kind).map((p) => p.data);
  const wanted = input.classLevels === 'all' ? null : new Set(input.classLevels);
  const levels = of('class_levels').filter((l) => !wanted || wanted.has(l.key));
  const groupsUsed = new Set<GroupKey>(levels.map((l) => l.group));
  const result = { levelGroups: 0, classLevels: 0, arms: 0, subjects: 0, classSubjects: 0, gradingScales: 0, assessmentStructures: 0, traits: 0, feeItems: 0, comments: 0 };

  // ---- grading scales and assessment structures
  const scaleIdByGroup = new Map<string, any>();
  const structIdByGroup = new Map<string, any>();
  if (input.grading) {
    for (const g of of('grading_scales')) {
      const r = await GradingScale.updateOne({ name: g.name }, { $setOnInsert: { name: g.name, passMark: g.passMark, bands: g.bands } }, { upsert: true });
      if (r.upsertedCount) result.gradingScales += 1;
      const doc = await GradingScale.findOne({ name: g.name }).select('_id').lean();
      for (const grp of g.groups ?? []) scaleIdByGroup.set(grp, doc._id);
    }
    for (const a of of('assessment_structures')) {
      const r = await AssessmentStructure.updateOne({ name: a.name }, { $setOnInsert: { name: a.name, components: a.components } }, { upsert: true });
      if (r.upsertedCount) result.assessmentStructures += 1;
      const doc = await AssessmentStructure.findOne({ name: a.name }).select('_id').lean();
      for (const grp of a.groups ?? []) structIdByGroup.set(grp, doc._id);
    }
  }

  // ---- level groups
  const groupDocs = new Map<string, any>();
  for (const g of GROUPS) {
    if (!groupsUsed.has(g.key)) continue;
    const set: Record<string, unknown> = {};
    if (scaleIdByGroup.get(g.key)) set.gradingScaleId = scaleIdByGroup.get(g.key);
    if (structIdByGroup.get(g.key)) set.assessmentStructureId = structIdByGroup.get(g.key);
    const r = await LevelGroup.updateOne(
      { name: g.name },
      { $setOnInsert: { name: g.name, key: g.key, order: g.order, reportLayout: g.layout, showPositions: g.showPositions }, ...(Object.keys(set).length ? { $set: set } : {}) },
      { upsert: true }
    );
    if (r.upsertedCount) result.levelGroups += 1;
    groupDocs.set(g.key, await LevelGroup.findOne({ name: g.name }).lean());
  }

  // ---- class levels with one arm each, and the progression map
  const levelDocs = new Map<string, any>();
  for (const l of levels) {
    const r = await ClassLevel.updateOne(
      { name: l.name },
      { $setOnInsert: { name: l.name, presetKey: l.key, order: l.order, levelGroupId: groupDocs.get(l.group)._id, isFinal: !!l.isFinal, studentLogin: !!l.studentLogin, active: true } },
      { upsert: true }
    );
    if (r.upsertedCount) result.classLevels += 1;
    const doc = await ClassLevel.findOne({ name: l.name }).lean();
    levelDocs.set(l.key, doc);
    const a = await ClassArm.updateOne({ classLevelId: doc._id, name: 'A' }, { $setOnInsert: { classLevelId: doc._id, name: 'A', active: true } }, { upsert: true });
    if (a.upsertedCount) result.arms += 1;
  }
  // Progression map: which level follows which, including moves across sections.
  const allLevelDocs = new Map<string, any>((await ClassLevel.find({}).lean()).map((l: any) => [l.presetKey, l]));
  for (const l of levels) {
    const next = l.nextKey ? allLevelDocs.get(l.nextKey) : null;
    const cur = levelDocs.get(l.key);
    if (next && !cur.nextLevelId) await ClassLevel.updateOne({ _id: cur._id }, { nextLevelId: next._id });
  }

  // ---- subjects
  if (input.subjects) {
    for (const s of of('subjects')) {
      const applicable = (s.groups as Array<{ group: GroupKey; compulsory: boolean; department?: string }>).filter((g) => groupsUsed.has(g.group));
      if (!applicable.length) continue;
      const r = await Subject.updateOne({ name: s.name }, { $setOnInsert: { name: s.name, shortName: s.shortName, active: true } }, { upsert: true });
      if (r.upsertedCount) result.subjects += 1;
      const subject = await Subject.findOne({ name: s.name }).select('_id').lean();
      for (const l of levels) {
        const g = applicable.find((x) => x.group === l.group);
        if (!g) continue;
        const cs = await ClassSubject.updateOne(
          { classLevelId: levelDocs.get(l.key)._id, subjectId: subject._id },
          { $setOnInsert: { classLevelId: levelDocs.get(l.key)._id, subjectId: subject._id, compulsory: g.compulsory, department: g.department } },
          { upsert: true }
        );
        if (cs.upsertedCount) result.classSubjects += 1;
      }
    }
  }

  // ---- traits, fee items, comment bank
  if (input.traits) {
    for (const t of of('behaviour_traits')) {
      for (const grp of (t.groups ?? []) as GroupKey[]) {
        const lg = groupDocs.get(grp);
        if (!lg) continue;
        const r = await Trait.updateOne({ levelGroupId: lg._id, name: t.name }, { $setOnInsert: { levelGroupId: lg._id, name: t.name, category: t.category, scale: t.scale, active: true } }, { upsert: true });
        if (r.upsertedCount) result.traits += 1;
      }
    }
  }
  if (input.feeItems) {
    for (const f of of('fee_items')) {
      const r = await FeeItem.updateOne({ name: f.name }, { $setOnInsert: { name: f.name, optional: !!f.optional, active: true } }, { upsert: true });
      if (r.upsertedCount) result.feeItems += 1;
    }
  }
  if (input.commentBank && !(await CommentBank.countDocuments({}))) {
    const entries = of('comment_bank');
    if (entries.length) await CommentBank.insertMany(entries.map((c) => ({ author: c.author, minAverage: c.minAverage, maxAverage: c.maxAverage, text: c.text })));
    result.comments = entries.length;
  }

  await audit({ action: 'school.presets.applied', entityType: 'school', entityId: getCtx()!.schoolId, after: result });
  return result;
}

// ------------------------------------------------------------------ go live (send login details)

async function studentsNeedingLogin() {
  const session = await AcademicSession.findOne({ status: 'current' }).select('_id').lean();
  if (!session) return [];
  const levels = await ClassLevel.find({ studentLogin: true }).select('_id').lean();
  if (!levels.length) return [];
  const enrolments = await Enrolment.find({ sessionId: session._id, classLevelId: { $in: levels.map((l: any) => l._id) } }).select('studentId').lean();
  const students = await Student.find({ _id: { $in: enrolments.map((e: any) => e.studentId) }, status: 'active', userId: { $exists: false } }).lean();
  return students;
}

async function guardiansNeedingInvite() {
  const activeStudentIds = (await Student.find({ status: 'active' }).select('_id').lean()).map((s: any) => s._id);
  const links = await StudentGuardian.find({ studentId: { $in: activeStudentIds }, access: { $ne: 'none' } }).lean();
  const guardianIds = [...new Set(links.map((l: any) => String(l.guardianId)))];
  const guardians = await Guardian.find({ _id: { $in: guardianIds }, lastInvitedAt: { $exists: false } }).lean();
  return { guardians, links };
}

export async function goLivePreview() {
  const progress = await computeSetupProgress();
  const { guardians } = await guardiansNeedingInvite();
  const students = await studentsNeedingLogin();
  return { ...progress.goLive, parents: guardians.length, students: students.length, schoolStatus: progress.schoolStatus };
}

/** Send login details to parents and students not yet invited. Running it twice sends nothing new. */
export async function goLive() {
  const c = me();
  const school: any = await loadSchool();
  if (school.status !== 'active') throw new AppError('school_not_active', 'This school is waiting for approval. Parent logins open when it is approved.');
  const progress = await computeSetupProgress();
  if (!progress.goLive.canSend) {
    throw new AppError('state_conflict', 'Finish the required setup steps before sending logins.', { details: { missing: progress.goLive.missing } });
  }
  const preview = await goLivePreview();
  const jobId = await enqueue('go-live', {}, { schoolId: c.schoolId, userId: c.userId });
  await audit({ action: 'school.go_live', entityType: 'school', entityId: c.schoolId, after: { parents: preview.parents, students: preview.students } });
  return { jobId, parents: preview.parents, students: preview.students };
}

registerJob('go-live', async ({ schoolId }) => {
  const school: any = await School.findById(schoolId).lean();
  const link = schoolLink(school.slug, '/portal/login');
  const { guardians, links } = await guardiansNeedingInvite();
  const studentIdsByGuardian = new Map<string, string[]>();
  for (const l of links) {
    const k = String(l.guardianId);
    if (!studentIdsByGuardian.has(k)) studentIdsByGuardian.set(k, []);
    studentIdsByGuardian.get(k)!.push(String(l.studentId));
  }
  const allStudents = new Map<string, any>((await Student.find({ _id: { $in: [...new Set(links.map((l: any) => String(l.studentId)))] } }).select('firstName lastName admissionNumber').lean()).map((s: any) => [String(s._id), s]));

  let parents = 0;
  for (const g of guardians) {
    const issued = await ensureGuardianAccount(g, schoolId!);
    const kids = (studentIdsByGuardian.get(String(g._id)) ?? []).map((id) => allStudents.get(id)?.firstName).filter(Boolean).join(' and ');
    if (issued.temporaryPassword) {
      await notify({ schoolId, event: 'enrolled', to: [{ userId: issued.userId, phone: g.phone, email: g.email, name: fullName(g), kind: 'parent' }], vars: { child: kids || 'your child', link, login: g.phone, password: issued.temporaryPassword } });
    } else {
      await notify({ schoolId, event: 'application_status', to: [{ userId: issued.userId, phone: g.phone, email: g.email, kind: 'parent' }], vars: { child: kids, number: '', status: 'ready', note: `Sign in with your existing login to see ${kids || 'your child'}.` } });
    }
    parents += 1;
  }

  let studentsDone = 0;
  const students = await studentsNeedingLogin();
  for (const s of students) {
    const issued = await ensureStudentAccount(s, schoolId!);
    if (issued.temporaryPassword) {
      const main = await StudentGuardian.findOne({ studentId: s._id }).sort({ isPrimary: -1 }).lean();
      const mg: any = main ? await Guardian.findById(main.guardianId).lean() : null;
      if (mg) await notify({ schoolId, event: 'enrolled', to: [{ phone: mg.phone, email: mg.email, kind: 'parent' }], vars: { child: `${fullName(s)} (student login)`, link, login: s.admissionNumber, password: issued.temporaryPassword } });
      studentsDone += 1;
    }
  }
  if (!school.setupProgress?.liveAt) await School.updateOne({ _id: schoolId }, { 'setupProgress.liveAt': new Date() });
  return { parents, students: studentsDone };
});
