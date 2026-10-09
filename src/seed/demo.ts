import { emptyCtx, forSchool, runWithCtx, asPlatform } from '../core/context';
import { permissionsForRoles } from '../core/permissions';
import { addDays, todayLagos } from '../lib/dates';
import { hashPassword } from '../lib/passwords';
import {
  AcademicSession, Application, AttendanceRegister, ClassArm, ClassLevel, Credit, Enrolment, Guardian, Invoice, Membership, Payment, School, Staff, Student, StudentGuardian, Subject, Term, User, Task, Submission, AdmissionSettings, ClassSubject, Site, Post
} from '../models';
import { applyPresets } from '../services/setup';
import { nextApplicationNumber } from '../services/admissions';
import { createSession, openTerm } from '../services/academics';
import { addStaff, setTeachingAssignments } from '../services/staff';
import { enrolStudent } from '../services/students';
import { generateInvoicesFor, setFeeStructure, requestDiscount, recomputeInvoice, createInvoice } from '../services/fees';
import { tx } from '../core/db';
import { tenantModelNames } from '../core/tenancy';
import mongoose from 'mongoose';
import { recordOffline, requestReversal, applyReversal } from '../services/payments';
import { writeLegacy } from '../services/imports';
import { saveCells, submitSheet } from '../services/scores';
import { saveRegister } from '../services/attendance';
import { createTask, publishTask } from '../services/tasks';
import { Approval, FeeItem } from '../models';
import { seedPlatformPresets } from './presets';
import { effectiveContent } from '../services/website';

/**
 * The demo school (Document 5, section 8): one seeded school used for development, demonstrations, tests and training.
 * One command recreates it. It never holds real personal data: every name, phone number and address here is made up, and the
 * phone numbers are in a range that is not assigned to anyone.
 */

export const DEMO_SLUG = 'demo';
export const DEMO_PASSWORD = 'Demo-Pass-2026!';

// small deterministic random generator so the demo school is the same every time
let seed = 20261007;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const FIRST_M = ['Chinedu', 'Tunde', 'Emeka', 'Ibrahim', 'Femi', 'Kelechi', 'Yusuf', 'Segun', 'Obinna', 'Musa', 'Dayo', 'Uche', 'Tobi', 'Sani', 'Kunle'];
const FIRST_F = ['Ngozi', 'Amina', 'Bisi', 'Chioma', 'Zainab', 'Folake', 'Ada', 'Hauwa', 'Temi', 'Ifeoma', 'Sade', 'Aisha', 'Kemi', 'Nneka', 'Titi'];
const LAST = ['Okafor', 'Adeyemi', 'Bello', 'Eze', 'Balogun', 'Nwosu', 'Abubakar', 'Ogunleye', 'Danjuma', 'Obi', 'Lawal', 'Ibe', 'Afolabi', 'Musa', 'Okoro', 'Salami', 'Uzor', 'Yakubu'];
const phone = (n: number) => `+2348000${String(n).padStart(6, '0')}`; // 0800... is not an assigned range

const asUser = <T>(schoolId: string, userId: string, roles: string[], staffId: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const ctx = { ...emptyCtx(), userId, roles, permissions: permissionsForRoles(roles), staffId, schoolId, kind: 'staff' as const };
  return runWithCtx(ctx, () => forSchool(schoolId, fn));
};

export async function seedDemoSchool(opts: { reset?: boolean; students?: number } = {}) {
  await seedPlatformPresets();
  seed = 20261007;
  const targetStudents = opts.students ?? 240;
  const today = todayLagos();
  const password = await hashPassword(DEMO_PASSWORD);

  // ---- start clean
  if (opts.reset !== false) await wipeDemo();

  // ---- the school
  const owner = await asPlatform(() => User.create({ firstName: 'Ada', lastName: 'Obi', phone: phone(1), email: 'owner@demo.example', passwordHash: password }));
  const school: any = await asPlatform(() =>
    School.create({
      name: 'Greenfield Demo Schools', slug: DEMO_SLUG, types: ['nursery', 'primary', 'secondary'], status: 'active', motto: 'Learning that lasts',
      address: { street: '12 Palm Avenue', town: 'Ikeja', lga: 'Ikeja', state: 'Lagos' }, phone: phone(2), email: 'info@demo.example', ownerUserId: owner._id,
      branding: { primary: '#1d4ed8', secondary: '#f59e0b' }, paystack: { subaccountCode: 'ACCT_demo0001', bankCode: '058', accountLast4: '0001', accountName: 'Greenfield Demo Schools', bankName: 'GTBank' },
      settings: { receiptPrefix: 'GFS', admissionNumberFormat: 'GFS/{YY}/{SEQ:4}', absenceSms: false, chargeBearer: 'parent', partPayment: { enabled: true, minPercent: 10 } },
      statusHistory: [{ status: 'active', at: new Date() }], termsAcceptedAt: new Date(), dpaAcceptedAt: new Date(), createdVia: 'assisted'
    })
  );
  const sid = String(school._id);

  const mkStaff = async (first: string, last: string, n: number, roles: string[]) => {
    const u = n === 1 ? owner : await asPlatform(() => User.create({ firstName: first, lastName: last, phone: phone(n), passwordHash: password }));
    const s: any = await forSchool(sid, () => Staff.create({ userId: u._id, firstName: first, lastName: last, phone: phone(n), roles, status: 'active' }));
    await asPlatform(() => Membership.create({ userId: u._id, schoolId: school._id, kind: 'staff', roles, staffId: s._id, status: 'active', acceptedAt: new Date() }));
    return { user: u, staff: s };
  };
  // One owner who is also principal, one admin, one bursar, twelve teachers
  const ownerPrincipal = await mkStaff('Ada', 'Obi', 1, ['owner', 'principal']);
  const admin = await mkStaff('Bisi', 'Lawal', 3, ['school_admin']);
  const bursar = await mkStaff('Kelechi', 'Eze', 4, ['bursar']);
  const teachers: Array<{ user: any; staff: any }> = [];
  for (let i = 0; i < 12; i++) teachers.push(await mkStaff(FIRST_F[i % FIRST_F.length], LAST[i % LAST.length], 10 + i, ['class_teacher', 'subject_teacher']));
  void admin;

  const O = (fn: () => Promise<any>) => asUser(sid, String(owner._id), ['owner', 'principal'], String(ownerPrincipal.staff._id), fn);

  // ---- structure: Nursery 1 to SSS 3, two arms in JSS 1 to 3, one arm elsewhere
  await O(() => applyPresets({ classLevels: 'all', subjects: true, grading: true, traits: true, feeItems: true, commentBank: true }));
  await forSchool(sid, async () => {
    for (const name of ['JSS 1', 'JSS 2', 'JSS 3']) {
      const l: any = await ClassLevel.findOne({ name }).lean();
      await ClassArm.updateOne({ classLevelId: l._id, name: 'B' }, { $setOnInsert: { classLevelId: l._id, name: 'B', active: true } }, { upsert: true });
    }
    await ClassLevel.deleteOne({ name: 'Creche' }); // Nursery 1 is the first level
    await ClassArm.deleteMany({ classLevelId: { $nin: (await ClassLevel.find({}).select('_id').lean()).map((l: any) => l._id) } });
  });

  // ---- one closed past session with three terms of imported results, and the current session in second term
  const yearStart = new Date().getFullYear();
  const past = `${yearStart - 2}/${yearStart - 1}`;
  const current = `${yearStart - 1}/${yearStart}`;
  const terms = [
    { number: 1 as const, startDate: addDays(today, -150), endDate: addDays(today, -75), nextTermBegins: addDays(today, -70) },
    { number: 2 as const, startDate: addDays(today, -70), endDate: addDays(today, 40), nextTermBegins: addDays(today, 60) },
    { number: 3 as const, startDate: addDays(today, 60), endDate: addDays(today, 140) }
  ];
  const created = await O(() => createSession({ name: current, terms }));
  await O(async () => {
    const t1 = created.terms.find((t: any) => t.number === 1);
    const t2 = created.terms.find((t: any) => t.number === 2);
    await Term.updateOne({ _id: t1._id }, { status: 'closed', closedAt: new Date() });
    await openTerm(String(t2._id));
  });

  const levels: any[] = await forSchool(sid, () => ClassLevel.find({}).sort({ order: 1 }).lean());
  const arms: any[] = await forSchool(sid, () => ClassArm.find({}).lean());
  const subjects: any[] = await forSchool(sid, () => Subject.find({}).lean());

  // ---- fees for the term
  const items: Record<string, string> = Object.fromEntries((await forSchool(sid, () => FeeItem.find({}).lean())).map((i: any) => [i.name, String(i._id)]));
  const termDoc: any = await forSchool(sid, () => Term.findOne({ status: 'current' }).lean());
  for (const l of levels) {
    const base = l.name.startsWith('Nursery') ? 30000 : l.name.startsWith('Primary') ? 45000 : l.name.startsWith('JSS') ? 60000 : 75000;
    await O(() => setFeeStructure(String(termDoc._id), String(l._id), [{ feeItemId: items.Tuition, amountKobo: base * 100 }, { feeItemId: items.Examination, amountKobo: 500000 }, { feeItemId: items['PTA levy'], amountKobo: 200000 }, { feeItemId: items.Uniform, amountKobo: 800000 }]));
  }

  // ---- students (siblings share a guardian; twins; a guardian with children in two classes; one withdrawn)
  const perArm = new Map<string, number>();
  const students: any[] = [];
  let guardianSeq = 100;
  const familyPhones: string[] = [];
  const target = targetStudents;
  let i = 0;
  while (students.length < target) {
    const familyKids = students.length < target - 80 ? 1 + (rnd() < 0.42 ? 1 : 0) : 1;
    const gPhone = phone(guardianSeq++);
    familyPhones.push(gPhone);
    const last = pick(LAST);
    const g = { firstName: pick(FIRST_F), lastName: last, phone: gPhone, relationship: 'mother' };
    for (let k = 0; k < familyKids && students.length < target; k++) {
      const arm = arms[students.length % arms.length];
      const female = rnd() < 0.5;
      const kid = await O(() =>
        enrolStudent(
          { child: { firstName: pick(female ? FIRST_F : FIRST_M), lastName: last, dob: `${yearStart - 6 - (levels.findIndex((l) => String(l._id) === String(arm.classLevelId)) % 12)}-0${1 + (i % 9)}-1${i % 9}`, gender: female ? 'female' : 'male' }, guardians: [g], classArmId: String(arm._id), consent: { onFile: true, source: 'import', at: new Date() } },
          { sendLogins: false }
        )
      );
      perArm.set(String(arm._id), (perArm.get(String(arm._id)) ?? 0) + 1);
      students.push(kid);
      i += 1;
    }
  }
  // twins: two children of one family born the same day, in one class
  const twinG = { firstName: 'Folake', lastName: 'Balogun', phone: phone(guardianSeq), relationship: 'mother' };
  const armForTwins = arms.find((a) => levels.find((l) => String(l._id) === String(a.classLevelId))?.name === 'Primary 3');
  for (const n of ['Taiwo', 'Kehinde']) students.push(await O(() => enrolStudent({ child: { firstName: n, lastName: 'Balogun', dob: `${yearStart - 9}-05-05`, gender: 'male' }, guardians: [twinG], classArmId: String(armForTwins._id), consent: { onFile: true, source: 'import' } }, { sendLogins: false })));
  // a teacher who is also a parent in the same school
  const teacherParent = teachers[0];
  students.push(await O(() => enrolStudent({ child: { firstName: 'Ife', lastName: teacherParent.staff.lastName, dob: `${yearStart - 8}-02-02`, gender: 'female' }, guardians: [{ firstName: teacherParent.staff.firstName, lastName: teacherParent.staff.lastName, phone: teacherParent.staff.phone }], classArmId: String(armForTwins._id), consent: { onFile: true, source: 'import' } }, { sendLogins: false })));
  // one withdrawn student
  const gone = students[5];
  await forSchool(sid, () => Student.updateOne({ _id: gone.student._id }, { status: 'withdrawn', $push: { statusHistory: { status: 'withdrawn', at: new Date(), date: today, reason: 'Moved abroad' } } }));

  // ---- teaching assignments for every class
  const assignItems: any[] = [];
  arms.forEach((a, idx) => {
    const t = teachers[idx % teachers.length];
    assignItems.push({ classArmId: String(a._id), staffId: String(t.staff._id), kind: 'class_teacher' });
  });
  const classSubjects: any[] = await forSchool(sid, () => ClassSubject.find({}).lean());
  for (const a of arms) {
    const subs = classSubjects.filter((c) => String(c.classLevelId) === String(a.classLevelId));
    subs.forEach((s, k) => assignItems.push({ classArmId: String(a._id), subjectId: String(s.subjectId), staffId: String(teachers[(arms.indexOf(a) + k) % teachers.length].staff._id), kind: 'subject_teacher' }));
  }
  await O(() => setTeachingAssignments(undefined, assignItems));

  // ---- past results (a closed session with imported records)
  const p4: any = levels.find((l) => l.name === 'Primary 4');
  const p4arm: any = arms.find((a) => String(a.classLevelId) === String(p4._id));
  const p4kids = await forSchool(sid, async () => (await Enrolment.find({ classArmId: p4arm._id }).select('studentId').lean()).map((e: any) => String(e.studentId)));
  const eng = subjects.find((s) => s.name === 'English Language');
  const mth = subjects.find((s) => s.name === 'Mathematics');
  for (const n of [1, 2, 3] as const) {
    await O(() => writeLegacy({ sessionName: past, termNumber: n, classArmId: String(p4arm._id), mode: 'totals', rows: p4kids.flatMap((id) => [{ studentId: id, subjectId: String(eng._id), total: 50 + Math.floor(rnd() * 45) }, { studentId: id, subjectId: String(mth._id), total: 45 + Math.floor(rnd() * 50) }]) }));
  }

  // ---- invoices and payments: paid, part paid, unpaid, discounted, one credit, one pending proof, one reversed payment, arrears
  await O(() => generateInvoicesFor(String(termDoc._id)));
  const invs: any[] = await forSchool(sid, () => Invoice.find({ kind: 'term' }).sort({ createdAt: 1 }).lean());
  const bur = (fn: () => Promise<any>) => asUser(sid, String(bursar.user._id), ['bursar'], String(bursar.staff._id), fn);
  for (let k = 0; k < invs.length; k++) {
    const inv = invs[k];
    if (!inv.studentId || String(inv.studentId) === String(gone.student._id)) continue;
    const bucket = k % 10;
    if (bucket < 4) await bur(() => recordOffline({ studentId: String(inv.studentId), amountKobo: inv.totalKobo, channel: k % 3 ? 'transfer' : 'cash', paidOn: addDays(today, -(k % 30)), bankReference: `DEMO/${k}` }));
    else if (bucket < 7) await bur(() => recordOffline({ studentId: String(inv.studentId), amountKobo: Math.floor(inv.totalKobo * 0.4), channel: 'bank', paidOn: addDays(today, -(k % 20)), bankReference: `DEMO/${k}` }));
  }
  // a discounted invoice
  const discounted = invs.find((x, k) => k % 10 === 8 && x.studentId);
  if (discounted) {
    const appr = await bur(() => requestDiscount(String(discounted._id), { label: 'Sibling discount', spec: { type: 'percent', percent: 10 }, reason: 'Second child in the school' }));
    await forSchool(sid, async () => {
      const inv: any = await Invoice.findById(discounted._id);
      inv.discounts.push({ label: 'Sibling discount', amountKobo: Math.floor(inv.totalKobo * 0.1), approvalId: appr._id });
      await inv.save();
      await Approval.updateOne({ _id: appr._id }, { status: 'approved', decidedAt: new Date() });
      await recomputeInvoice(inv._id);
    });
  }
  // overpayment credit
  const over = invs.find((x, k) => k % 10 === 9 && x.studentId);
  if (over) await bur(() => recordOffline({ studentId: String(over.studentId), amountKobo: over.totalKobo + 500000, channel: 'cash', paidOn: today }));
  // a reversed payment
  const rev = invs.find((x, k) => k % 10 === 7 && x.studentId);
  if (rev) {
    const rp = await bur(() => recordOffline({ studentId: String(rev.studentId), amountKobo: 1000000, channel: 'cash', paidOn: today, bankReference: 'DEMO/REV' }));
    const approval = await bur(() => requestReversal(String(rp.paymentId), 'Entered against the wrong child'));
    await O(async () => {
      await tx((session) => applyReversal(approval, session));
      await Approval.updateOne({ _id: approval._id }, { status: 'approved', decidedAt: new Date() });
    });
  }
  // a pending proof of payment
  const proofStudent = invs.find((x, k) => k % 10 === 5 && x.studentId);
  if (proofStudent) await forSchool(sid, () => Payment.create({ reference: 'PRF-GFS-DEMO0001', channel: 'transfer', status: 'pending_confirmation', amountKobo: 2000000, allocations: [{ invoiceId: proofStudent._id, studentId: proofStudent.studentId, amountKobo: 2000000 }], bankReference: 'GTB/DEMO/1', paidOn: today, purpose: 'fees' }));
  // arrears from the past session
  const arrearsStudent = students[8];
  if (arrearsStudent) await forSchool(sid, async () => { await createInvoice({ studentId: String(arrearsStudent.student._id), kind: 'opening_balance', lines: [{ label: 'Balance brought forward', amountKobo: 3500000 }] }); });
  void Credit;

  // ---- registers for the term so far, six tasks, and score sheets at different stages
  const termStart = termDoc.startDate as string;
  const days: string[] = [];
  for (let d = addDays(today, -6); d <= today; d = addDays(d, 1)) if (d >= termStart && ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) days.push(d);
  for (const a of arms.slice(0, 8)) {
    const ct = assignItems.find((x) => x.classArmId === String(a._id) && x.kind === 'class_teacher');
    const teacher = teachers.find((t) => String(t.staff._id) === ct.staffId)!;
    const roster = await forSchool(sid, async () => (await Enrolment.find({ classArmId: a._id }).select('studentId').lean()).map((e: any) => String(e.studentId)));
    for (const d of days) await asUser(sid, String(teacher.user._id), ['class_teacher'], String(teacher.staff._id), () => saveRegister({ classArmId: String(a._id), date: d, entries: roster.filter((_, i2) => i2 % 11 === days.indexOf(d) % 11).map((s) => ({ studentId: s, status: 'absent' as const })) })).catch(() => undefined);
  }
  const jss1: any = arms.find((a) => levels.find((l) => String(l._id) === String(a.classLevelId))?.name === 'JSS 1');
  const jssAssign = assignItems.filter((x) => x.classArmId === String(jss1._id) && x.kind === 'subject_teacher');
  for (let t = 0; t < 6 && t < jssAssign.length; t++) {
    const a = jssAssign[t];
    const teacher = teachers.find((x) => String(x.staff._id) === a.staffId)!;
    await asUser(sid, String(teacher.user._id), ['class_teacher', 'subject_teacher'], String(teacher.staff._id), async () => {
      const task: any = await createTask({ classArmId: a.classArmId, subjectId: a.subjectId, type: (['assignment', 'homework', 'project', 'test'] as const)[t % 4], title: `Demo ${(['assignment', 'homework', 'project', 'test'] as const)[t % 4]} ${t + 1}`, maxScore: 10, lateRule: 'allow_flag', allowResubmit: true });
      await publishTask(String(task._id));
      const kids = (await Enrolment.find({ classArmId: a.classArmId }).select('studentId').lean()).slice(0, 8);
      kids.forEach(async () => undefined);
      for (const [idx, e] of kids.entries()) {
        await Submission.create({ taskId: task._id, studentId: (e as any).studentId, status: idx % 3 === 0 ? 'marked' : idx % 3 === 1 ? 'submitted' : 'returned', text: 'My answer', submittedAt: new Date(), isLate: idx === 4, score: idx % 3 === 0 ? 6 + (idx % 4) : undefined, feedback: idx % 3 === 0 ? 'Well done.' : undefined, returnNote: idx % 3 === 2 ? 'Show your working.' : undefined });
      }
    });
  }
  // score sheets: Primary 4 fully submitted, JSS 1 half entered, others untouched
  for (const arm of [p4arm, jss1]) {
    const subs = assignItems.filter((x) => x.classArmId === String(arm._id) && x.kind === 'subject_teacher');
    const kids = await forSchool(sid, async () => (await Enrolment.find({ classArmId: arm._id }).select('studentId').lean()).map((e: any) => String(e.studentId)));
    for (const [si, s] of subs.entries()) {
      const teacher = teachers.find((x) => String(x.staff._id) === s.staffId)!;
      await asUser(sid, String(teacher.user._id), ['class_teacher', 'subject_teacher'], String(teacher.staff._id), async () => {
        if (arm === jss1 && si % 2) return;
        const cells = kids.flatMap((k, idx) => [{ studentId: k, component: 'ca1', score: 10 + (idx % 10) }, { studentId: k, component: 'ca2', score: 11 + (idx % 9) }, { studentId: k, component: 'exam', score: 30 + (idx % 28) }]);
        await saveCells(String(arm._id), s.subjectId, undefined, cells);
        if (arm === p4arm) await submitSheet(String(arm._id), s.subjectId, undefined);
      }).catch(() => undefined);
    }
  }

  // ---- applications in every status
  const settingsSession = created.s._id;
  await forSchool(sid, async () => {
    await AdmissionSettings.updateOne({ sessionId: settingsSession }, { $set: { open: true, classLevelIds: levels.slice(0, 6).map((l) => l._id), requiredDocuments: ['birth_certificate'], applicationFeeKobo: 0, offerValidDays: 14 } }, { upsert: true });
    let n = 1;
    for (const status of ['draft', 'submitted', 'under_review', 'assessment_scheduled', 'offered', 'accepted', 'enrolled', 'waitlisted', 'rejected', 'withdrawn', 'expired']) {
      await Application.create({
        sessionId: settingsSession, status, number: status === 'draft' ? undefined : await nextApplicationNumber(),
        child: { firstName: pick(FIRST_M), lastName: pick(LAST), dob: `${yearStart - 7}-03-0${1 + (n % 8)}`, gender: 'male' }, guardian: { firstName: pick(FIRST_F), lastName: pick(LAST), phone: phone(900 + n), relationship: 'mother' },
        classLevelId: levels[3]._id, previousSchool: 'Little Stars Nursery', draftPhone: status === 'draft' ? phone(900 + n) : undefined, statusHistory: [{ status, at: new Date() }], submittedAt: status === 'draft' ? undefined : new Date()
      });
      n += 1;
    }
  });

  // ---- a published school website with real text, so the public pages and the admissions form have something to show
  await forSchool(sid, async () => {
    const content = effectiveContent(school.toObject ? school.toObject() : school, {
      home: { hero: { headline: 'Learning that lasts', subline: 'A friendly school in Ikeja where every child is known by name.', buttonLabel: 'Apply now' }, highlights: [{ title: 'Caring teachers', text: 'Small classes and teachers who know every child.' }, { title: 'A safe place to learn', text: 'Secure grounds, trained staff and a calm routine.' }, { title: 'Strong results', text: 'Consistent WAEC and NECO results for over twenty years.' }] },
      about: { history: 'Greenfield opened in 2004 with 30 children and has grown to a nursery, primary and secondary school.', mission: 'To give every child a strong foundation in learning and character.', vision: 'Confident young people ready for the world.', welcome: { name: 'Mrs Ada Obi', title: 'Principal', message: 'Welcome to Greenfield. We would love to meet your family.' } },
      admissions: { intro: 'Applications for the new session are open for Nursery 1 to Primary 5.' }
    });
    await Site.updateOne({}, { $set: { status: 'published', draft: content, published: content, templateVersion: 1, publishedAt: new Date() } }, { upsert: true });
    await Post.create([
      { kind: 'news', title: 'Welcome back to second term', body: 'Classes resume on Monday. Please check the fee schedule on the parent portal.', published: true },
      { kind: 'event', title: 'Inter-house sports day', body: 'Parents are invited to watch from 9am.', eventDate: addDays(today, 21), published: true }
    ]);
  });

  // ---- a small second school with different colours, sharing one parent, for tenancy and switching tests
  const second: any = await asPlatform(() => School.create({ name: 'Riverside Primary', slug: 'riverside', types: ['primary'], status: 'active', address: { town: 'Yaba', lga: 'Lagos Mainland', state: 'Lagos' }, phone: phone(3), email: 'hello@riverside.example', branding: { primary: '#0f766e', secondary: '#be123c' }, settings: { receiptPrefix: 'RVP' }, ownerUserId: owner._id }));
  const secondOwner = await asPlatform(() => User.create({ firstName: 'Segun', lastName: 'Ajayi', phone: phone(5), passwordHash: password }));
  const sstaff: any = await forSchool(String(second._id), () => Staff.create({ userId: secondOwner._id, firstName: 'Segun', lastName: 'Ajayi', phone: phone(5), roles: ['owner'], status: 'active' }));
  await asPlatform(() => Membership.create({ userId: secondOwner._id, schoolId: second._id, kind: 'staff', roles: ['owner'], staffId: sstaff._id, status: 'active' }));
  // the shared parent is the guardian of a child who still owes part of the term fee, so the pay screens have something to pay
  const owing = invs.find((x, k) => k % 10 === 6 && x.studentId && String(x.studentId) !== String(gone.student._id));
  const owingLink: any = owing ? await forSchool(sid, () => StudentGuardian.findOne({ studentId: owing.studentId }).lean()) : null;
  const owingGuardian: any = owingLink ? await forSchool(sid, () => Guardian.findById(owingLink.guardianId).lean()) : null;
  const sharedPhone = owingGuardian?.phone ?? familyPhones[0];
  const sharedGuardianUser = await asPlatform(() => User.create({ firstName: 'Shared', lastName: 'Parent', phone: sharedPhone, passwordHash: password }));
  const g1: any = await forSchool(sid, () => Guardian.findOne({ phone: sharedPhone }));
  await forSchool(sid, () => Guardian.updateOne({ _id: g1._id }, { userId: sharedGuardianUser._id }));
  await asPlatform(() => Membership.create({ userId: sharedGuardianUser._id, schoolId: school._id, kind: 'guardian', guardianId: g1._id, status: 'active', roles: [] }));
  const g2: any = await forSchool(String(second._id), () => Guardian.create({ userId: sharedGuardianUser._id, firstName: 'Shared', lastName: 'Parent', phone: sharedPhone }));
  const sk: any = await forSchool(String(second._id), () => Student.create({ admissionNumber: 'RVP/26/0001', firstName: 'Riverside', lastName: 'Pupil', dob: '2017-01-01', gender: 'female' }));
  await forSchool(String(second._id), () => StudentGuardian.create({ studentId: sk._id, guardianId: g2._id, isPrimary: true, isFeePayer: true }));
  await asPlatform(() => Membership.create({ userId: sharedGuardianUser._id, schoolId: second._id, kind: 'guardian', guardianId: g2._id, status: 'active', roles: [] }));

  void addStaff; void AttendanceRegister;
  return { schoolId: sid, students: students.length, guardians: familyPhones.length + 2, password: DEMO_PASSWORD, owner: phone(1), bursar: phone(4), sharedParent: sharedPhone };
}

/** Remove the demo school and the users made for it, so the command can run again. */
export async function wipeDemo() {
  const old: any = await asPlatform(() => School.findOne({ slug: DEMO_SLUG }).select('_id').lean());
  const second: any = await asPlatform(() => School.findOne({ slug: 'riverside' }).select('_id').lean());
  for (const s of [old, second].filter(Boolean)) {
    for (const name of tenantModelNames) await mongoose.connection.collection(mongoose.model(name).collection.name).deleteMany({ schoolId: s._id });
    await mongoose.connection.collection('memberships').deleteMany({ schoolId: s._id });
    await mongoose.connection.collection('schools').deleteOne({ _id: s._id });
  }
  await mongoose.connection.collection('users').deleteMany({ phone: { $regex: '^\\+2348000' } });
  void Task;
}
