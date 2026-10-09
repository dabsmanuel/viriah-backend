import { createRoutes } from '../core/route';
import { z, objectId, name, text, dateStr, idParam, boolish } from '../core/validate';
import { created, noContent, ok } from '../core/http';
import { audit } from '../core/audit';
import { notFound, stateConflict, validation } from '../core/errors';
import { Term, AssessmentStructure, ClassLevel, CommentBank, Enrolment, GradingScale, LevelGroup, Subject, Trait, TermResult, ClassSubject, Student } from '../models';
import * as ac from '../services/academics';
import { need } from '../services/common';
import { assertCanSeeStudent, currentSession, resolveTerm } from '../services/reach';
import { suggestComment } from '../calc/comments';

const r = createRoutes();
export const router = r.router;

const VIEW = { perm: 'academics.view' } as const;
const MANAGE = { perm: 'academics.manage' } as const;

const termIn = z.object({ number: z.union([z.literal(1), z.literal(2), z.literal(3)]), startDate: dateStr.optional(), endDate: dateStr.optional(), nextTermBegins: dateStr.optional() }).strict();

// ------------------------------------------------------------------ sessions and terms

r.get('/sessions', { access: VIEW, summary: 'List sessions' }, async () => ok(await ac.sessionsWithTerms()));

r.post(
  '/sessions',
  { access: MANAGE, body: z.object({ name: z.string().trim().min(9).max(9), startDate: dateStr.optional(), endDate: dateStr.optional(), terms: z.array(termIn).length(3), importedOnly: z.boolean().optional(), makeCurrent: z.boolean().optional() }).strict(), summary: 'Create a session with its three terms' },
  async (req) => {
    const out = await ac.createSession(req.body);
    return created({ id: String(out.s._id), name: out.s.name, status: out.s.status, terms: out.terms.map((t: any) => ({ id: String(t._id), number: t.number, status: t.status })) });
  }
);

r.patch('/sessions/:id', { access: MANAGE, params: idParam, body: z.object({ name: z.string().trim().min(9).max(9).optional(), startDate: dateStr.optional(), endDate: dateStr.optional() }).strict(), summary: 'Edit name and dates' }, async (req) => ok(await ac.updateSession(req.params.id as string, req.body)));

r.get('/terms', { access: { perm: 'dashboard.view' }, query: z.object({ sessionId: objectId.optional() }).strict(), summary: 'List terms, with the current one marked' }, async (req) => {
  const q = req.query as { sessionId?: string };
  const terms = await Term.find(q.sessionId ? { sessionId: q.sessionId } : {}).sort({ sessionId: -1, number: 1 }).lean();
  return ok(terms.map((t: any) => ({ id: String(t._id), sessionId: String(t.sessionId), number: t.number, startDate: t.startDate, endDate: t.endDate, nextTermBegins: t.nextTermBegins, status: t.status, current: t.status === 'current' })));
});

r.patch('/terms/:id', { access: MANAGE, params: idParam, body: z.object({ startDate: dateStr.optional(), endDate: dateStr.optional(), nextTermBegins: dateStr.optional() }).strict(), summary: 'Edit dates and next term start date' }, async (req) => ok(await ac.updateTerm(req.params.id as string, req.body)));

const STATE = { perm: 'terms.state.manage' } as const;
r.post('/terms/:id/open', { access: STATE, params: idParam, summary: 'Make this the current term. Closes the previous one' }, async (req) => ok(await ac.openTerm(req.params.id as string)));
r.post('/terms/:id/close', { access: STATE, params: idParam, summary: 'Close the term' }, async (req) => ok(await ac.closeTerm(req.params.id as string)));
r.post('/terms/:id/reopen', { access: STATE, params: idParam, fresh: true, body: z.object({ reason: text(500).min(3, 'Give a reason.') }).strict(), summary: 'Reopen a closed term with a reason' }, async (req) => ok(await ac.reopenTerm(req.params.id as string, req.body.reason)));

// ------------------------------------------------------------------ level groups

r.get('/level-groups', { access: VIEW, summary: 'List level groups with their scale, structure and layout' }, async () => {
  const [groups, scales, structures] = await Promise.all([LevelGroup.find({}).sort({ order: 1 }).lean(), GradingScale.find({}).lean(), AssessmentStructure.find({}).lean()]);
  const byId = (xs: any[]) => new Map(xs.map((x) => [String(x._id), x]));
  const s = byId(scales);
  const a = byId(structures);
  return ok(groups.map((g: any) => ({ ...g, id: String(g._id), gradingScale: s.get(String(g.gradingScaleId)) ?? null, assessmentStructure: a.get(String(g.assessmentStructureId)) ?? null })));
});

r.patch(
  '/level-groups/:id',
  { access: MANAGE, params: idParam, body: z.object({ gradingScaleId: objectId.optional(), assessmentStructureId: objectId.optional(), reportLayout: z.enum(['scores', 'ratings']).optional(), showPositions: z.boolean().optional() }).strict(), summary: 'Set grading scale, assessment structure, report layout, positions on or off' },
  async (req) => ok(await ac.updateLevelGroup(req.params.id as string, req.body))
);

// ------------------------------------------------------------------ class levels and arms

r.get('/class-levels', { access: VIEW, summary: 'List class levels in order, with arms' }, async () => ok(await ac.classLevelsWithArms()));

r.post(
  '/class-levels',
  { access: MANAGE, body: z.object({ name: name(60), levelGroupId: objectId, order: z.number().int().min(0).optional(), nextLevelId: objectId.optional(), isFinal: z.boolean().optional(), studentLogin: z.boolean().optional() }).strict(), summary: 'Add a class level' },
  async (req) => created(await ac.createClassLevel(req.body))
);

r.patch(
  '/class-levels/:id',
  {
    access: MANAGE,
    params: idParam,
    body: z.object({ name: name(60).optional(), order: z.number().int().min(0).optional(), nextLevelId: objectId.nullable().optional(), isFinal: z.boolean().optional(), studentLogin: z.boolean().optional(), levelGroupId: objectId.optional(), active: z.boolean().optional() }).strict(),
    summary: 'Rename, reorder, set next level, final flag, student login'
  },
  async (req) => ok(await ac.updateClassLevel(req.params.id as string, req.body))
);

r.delete('/class-levels/:id', { access: MANAGE, params: idParam, summary: 'Remove a level that has never had students' }, async (req) => {
  await ac.deleteClassLevel(req.params.id as string);
  return noContent();
});

r.post('/class-arms', { access: MANAGE, body: z.object({ classLevelId: objectId, name: name(30) }).strict(), summary: 'Add an arm to a level' }, async (req) => created(await ac.createArm(req.body.classLevelId, req.body.name)));
r.patch('/class-arms/:id', { access: MANAGE, params: idParam, body: z.object({ name: name(30).optional(), active: z.boolean().optional() }).strict(), summary: 'Rename or deactivate an arm' }, async (req) => ok(await ac.updateArm(req.params.id as string, req.body)));

// ------------------------------------------------------------------ subjects

r.get('/subjects', { access: VIEW, summary: 'List subjects' }, async () => ok(await Subject.find({}).sort({ name: 1 }).lean()));
r.post('/subjects', { access: MANAGE, body: z.object({ name: name(80), shortName: z.string().trim().max(10).optional() }).strict(), summary: 'Add a subject' }, async (req) => {
  if (await Subject.exists({ name: req.body.name })) throw validation('This subject already exists.', { name: 'Already exists.' });
  return created(await Subject.create(req.body));
});
r.patch('/subjects/:id', { access: MANAGE, params: idParam, body: z.object({ name: name(80).optional(), shortName: z.string().trim().max(10).optional(), active: z.boolean().optional() }).strict(), summary: 'Edit or deactivate a subject' }, async (req) => {
  const s = await need(Subject.findById(req.params.id), 'Subject');
  if (req.body.name && req.body.name !== s.name && (await Subject.exists({ name: req.body.name, _id: { $ne: s._id } }))) throw validation('This subject already exists.', { name: 'Already exists.' });
  Object.assign(s, req.body);
  await s.save();
  return ok(s);
});

r.get('/class-levels/:id/subjects', { access: VIEW, params: idParam, summary: 'Subjects of a level with compulsory flag and department' }, async (req) => {
  await need(ClassLevel.findById(req.params.id).lean(), 'Class level');
  const rows = await ClassSubject.find({ classLevelId: req.params.id }).lean();
  const subjects = new Map<string, any>((await Subject.find({ _id: { $in: rows.map((x: any) => x.subjectId) } }).lean()).map((s: any) => [String(s._id), s]));
  return ok(rows.map((x: any) => ({ subjectId: String(x.subjectId), name: subjects.get(String(x.subjectId))?.name, shortName: subjects.get(String(x.subjectId))?.shortName, compulsory: x.compulsory, department: x.department })));
});

r.put(
  '/class-levels/:id/subjects',
  { access: MANAGE, params: idParam, body: z.object({ items: z.array(z.object({ subjectId: objectId, compulsory: z.boolean(), department: z.enum(['science', 'arts', 'commercial']).optional() }).strict()).max(80) }).strict(), summary: 'Set the subjects of a level' },
  async (req) => ok(await ac.setLevelSubjects(req.params.id as string, req.body.items))
);

// A student's subjects for a term. Staff, parent (own child) and student (self).
r.get('/students/:id/subjects', { access: { perm: 'students.subjects.view' }, params: idParam, query: z.object({ termId: objectId.optional() }).strict(), summary: 'A student’s subjects for a term' }, async (req) => {
  await assertCanSeeStudent(req.params.id as string);
  const term = await resolveTerm((req.query as any).termId);
  const session = await currentSession();
  const enrol: any = await Enrolment.findOne({ studentId: req.params.id, sessionId: term.sessionId ?? session?._id }).lean();
  if (!enrol) return ok([]);
  const offered = await ac.subjectsOfStudent(req.params.id as string, String(term._id), String(enrol.classLevelId));
  const subjects = new Map<string, any>((await Subject.find({ _id: { $in: offered.map((o: any) => o.subjectId) } }).lean()).map((s: any) => [String(s._id), s]));
  return ok(offered.map((o: any) => ({ subjectId: String(o.subjectId), name: subjects.get(String(o.subjectId))?.name, compulsory: o.compulsory })));
});

r.put(
  '/students/:id/subjects',
  { access: { perm: 'students.subjects.manage' }, params: idParam, body: z.object({ termId: objectId.optional(), subjectIds: z.array(objectId).max(60) }).strict(), summary: 'Set a student’s subjects for a term' },
  async (req) => {
    const term = await resolveTerm(req.body.termId);
    await ac.assertTermOpen(term._id);
    const enrol: any = await need(Enrolment.findOne({ studentId: req.params.id, sessionId: term.sessionId }).lean(), 'Enrolment');
    const out = await ac.setStudentSubjects(req.params.id as string, String(term._id), req.body.subjectIds, String(enrol.classLevelId), String(enrol.classArmId));
    return ok({ subjectIds: out });
  }
);

// ------------------------------------------------------------------ grading scales and assessment structures

const band = z.object({ min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100), grade: z.string().trim().min(1).max(4), remark: text(40) }).strict();
const scaleBody = z.object({ name: name(80), passMark: z.number().min(0).max(100), bands: z.array(band).min(1).max(15) }).strict();

r.get('/grading-scales', { access: VIEW, summary: 'List grading scales' }, async () => ok(await GradingScale.find({}).sort({ name: 1 }).lean()));
r.post('/grading-scales', { access: MANAGE, body: scaleBody, summary: 'Create a scale. Bands are checked for gaps and overlaps' }, async (req) => {
  ac.checkBands(req.body.bands);
  if (await GradingScale.exists({ name: req.body.name })) throw validation('A scale with this name already exists.', { name: 'Already exists.' });
  return created(await GradingScale.create(req.body));
});
r.patch('/grading-scales/:id', { access: { perm: 'terms.state.manage' }, params: idParam, body: scaleBody.partial().strict(), summary: 'Edit a scale. Refused if a published result in the current term uses it' }, async (req) => {
  const s = await need(GradingScale.findById(req.params.id), 'Grading scale');
  if (req.body.bands) ac.checkBands(req.body.bands);
  if (await ac.publishedResultUsesScale(String(s._id))) throw stateConflict('A result using this scale is already published this term, so it cannot be edited now.');
  Object.assign(s, req.body);
  await s.save();
  await audit({ action: 'academics.grading_scale.update', entityType: 'gradingScale', entityId: s._id, after: req.body });
  return ok(s);
});

const compKey = z.string().regex(/^[a-z][a-z0-9_]{0,19}$/, 'Use lowercase letters, digits or underscores.');
const structureBody = z.object({ name: name(80), components: z.array(z.object({ key: compKey, name: name(40), max: z.number().positive().max(100), order: z.number().int().min(1).max(10) }).strict()).min(1).max(8) }).strict();

r.get('/assessment-structures', { access: VIEW, summary: 'List assessment structures' }, async () => ok(await AssessmentStructure.find({}).sort({ name: 1 }).lean()));
r.post('/assessment-structures', { access: MANAGE, body: structureBody, summary: 'Create a structure. Maximums must total 100' }, async (req) => {
  ac.checkStructure(req.body.components);
  if (await AssessmentStructure.exists({ name: req.body.name })) throw validation('A structure with this name already exists.', { name: 'Already exists.' });
  return created(await AssessmentStructure.create(req.body));
});
r.patch('/assessment-structures/:id', { access: { perm: 'terms.state.manage' }, params: idParam, body: structureBody.partial().strict(), summary: 'Edit a structure. Refused once scores exist in the current term' }, async (req) => {
  const s = await need(AssessmentStructure.findById(req.params.id), 'Assessment structure');
  if (req.body.components) ac.checkStructure(req.body.components);
  if (await ac.scoresExistForStructure(String(s._id))) throw stateConflict('Scores already exist this term, so the structure cannot be edited now.');
  Object.assign(s, req.body);
  await s.save();
  await audit({ action: 'academics.assessment_structure.update', entityType: 'assessmentStructure', entityId: s._id, after: req.body });
  return ok(s);
});

// ------------------------------------------------------------------ traits and comment bank

const traitBody = z.object({ levelGroupId: objectId.optional(), name: name(60), category: z.enum(['behaviour', 'skill', 'learning_area']), scale: z.array(z.object({ value: z.number().int(), label: name(30) }).strict()).min(2).max(10), order: z.number().int().optional(), active: z.boolean().optional() }).strict();

r.get('/traits', { access: VIEW, query: z.object({ levelGroupId: objectId.optional(), category: z.enum(['behaviour', 'skill', 'learning_area']).optional() }).strict(), summary: 'List behaviour traits and nursery learning areas' }, async (req) => {
  const q = req.query as any;
  return ok(await Trait.find({ ...(q.levelGroupId ? { levelGroupId: q.levelGroupId } : {}), ...(q.category ? { category: q.category } : {}) }).sort({ order: 1, name: 1 }).lean());
});
r.post('/traits', { access: MANAGE, body: traitBody, summary: 'Add a trait' }, async (req) => created(await Trait.create(req.body)));
r.patch('/traits/:id', { access: MANAGE, params: idParam, body: traitBody.partial().strict(), summary: 'Edit a trait' }, async (req) => {
  const t = await need(Trait.findById(req.params.id), 'Trait');
  Object.assign(t, req.body);
  await t.save();
  return ok(t);
});
r.delete('/traits/:id', { access: MANAGE, params: idParam, summary: 'Remove an unused trait' }, async (req) => {
  await need(Trait.findById(req.params.id).lean(), 'Trait');
  if (await TermResult.exists({ 'ratings.traitId': req.params.id })) throw stateConflict('This trait is used in results. Switch it off instead.');
  await Trait.deleteOne({ _id: req.params.id });
  return noContent();
});

const commentBody = z.object({ author: z.enum(['class_teacher', 'principal']), minAverage: z.number().min(0).max(100), maxAverage: z.number().min(0).max(100), text: text(300).min(3) }).strict();
r.get('/comment-bank', { access: { perm: 'results.comments.manage' }, summary: 'List comment bank entries' }, async () => ok(await CommentBank.find({}).sort({ author: 1, minAverage: -1 }).lean()));
r.post('/comment-bank', { access: { perm: 'terms.state.manage' }, body: commentBody, summary: 'Add an entry' }, async (req) => {
  if (req.body.minAverage > req.body.maxAverage) throw validation('The lowest average is above the highest.', { minAverage: 'Must be below the highest.' });
  return created(await CommentBank.create(req.body));
});
r.patch('/comment-bank/:id', { access: { perm: 'terms.state.manage' }, params: idParam, body: commentBody.partial().strict(), summary: 'Edit an entry' }, async (req) => {
  const c = await need(CommentBank.findById(req.params.id), 'Comment');
  Object.assign(c, req.body);
  await c.save();
  return ok(c);
});
r.delete('/comment-bank/:id', { access: { perm: 'terms.state.manage' }, params: idParam, summary: 'Remove an entry' }, async (req) => {
  const res = await CommentBank.deleteOne({ _id: req.params.id });
  if (!res.deletedCount) throw notFound('Comment');
  return noContent();
});

export { boolish, suggestComment, Student };
