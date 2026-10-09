import { createRoutes } from '../core/route';
import { z, objectId, name, text, email, phone, pageQuery, idParam, dateStr } from '../core/validate';
import { created, list, noContent, ok, Reply } from '../core/http';
import { audit } from '../core/audit';
import { notFound } from '../core/errors';
import { paging } from '../core/pagination';
import { Enquiry, GalleryItem, Post } from '../models';
import { need } from '../services/common';
import * as web from '../services/website';

const r = createRoutes();
export const router = r.router;

// ------------------------------------------------------------------ public site (school taken from the host name)

const PUB = { access: 'public', host: true } as const;

r.get('/public/site', { ...PUB, query: z.object({ preview: z.string().max(1000).optional() }).strict(), summary: 'Published site content, brand tokens and school status for this host' }, async (req) => {
  const out = await web.publicSite((req.query as any).preview);
  // A suspended or taken-down school renders a single neutral page with status 503 and no indexing.
  if (out.neutral) return new Reply(503, { data: out }, { 'X-Robots-Tag': 'noindex', 'Retry-After': '3600' });
  return new Reply(200, { data: out }, { 'Cache-Control': out.preview ? 'no-store' : 'public, max-age=30, stale-while-revalidate=300', ...(out.preview ? { 'X-Robots-Tag': 'noindex' } : {}) });
});

r.get('/public/site/sitemap', { ...PUB, summary: 'This school’s sitemap entries' }, async () => ok(await web.publicSitemap()));

r.get('/public/site/posts', { ...PUB, query: z.object({ page: pageQuery.page, limit: pageQuery.limit, kind: z.enum(['news', 'event']).optional() }).strict(), summary: 'Published news and events' }, async (req) => {
  const q = req.query as any;
  const filter: any = { published: true, ...(q.kind ? { kind: q.kind } : {}) };
  const p = paging(q, ['createdAt'], '-createdAt');
  const [rows, total] = await Promise.all([Post.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), Post.countDocuments(filter)]);
  return list(rows.map((x: any) => web.postView(x, false)), { page: p.page, limit: p.limit, total });
});

r.get('/public/site/posts/:id', { ...PUB, params: idParam, summary: 'One post' }, async (req) => {
  const p = await Post.findOne({ _id: req.params.id, published: true }).lean();
  if (!p) throw notFound('Post');
  return ok(web.postView(p));
});

r.get('/public/site/gallery', { ...PUB, summary: 'Gallery items' }, async () => ok((await GalleryItem.find({}).sort({ order: 1 }).limit(100).lean()).map(web.galleryView)));

r.post(
  '/public/site/enquiries',
  {
    ...PUB,
    activeSchool: true,
    rate: { name: 'enquiry', windowMs: 60 * 60_000, max: 10 },
    body: z.object({ name: name(80), phone: phone.optional(), email: email.optional(), message: text(2000).min(5, 'Write a short message.'), website: z.string().max(200).optional() }).strict(),
    summary: 'Send an enquiry from the contact form'
  },
  async (req) => created(await web.receiveEnquiry(req.body, req.ip))
);

// ------------------------------------------------------------------ editor

const VIEW = { perm: 'website.view' } as const;
const MANAGE = { perm: 'website.manage' } as const;

r.get('/website', { access: VIEW, inactiveOk: true, summary: 'Draft content, published content, status and placeholder list' }, async () => ok(await web.websiteForEditor()));

const str = (n = 300) => z.string().max(n);
const sectionToggle = z.object({ home: z.boolean(), about: z.boolean(), academics: z.boolean(), admissions: z.boolean(), news: z.boolean(), gallery: z.boolean(), staff: z.boolean(), contact: z.boolean() }).partial().strict();
const POSITIONS = ['center', 'top', 'bottom', 'left', 'right'] as const;
const mediaPicture = z.object({ image: str(), caption: str(160).optional(), placement: z.enum(['left', 'right', 'top', 'bottom', 'full', 'grid']).default('grid'), size: z.enum(['small', 'medium', 'large']).default('medium') }).strict();
const sectionMedia = z
  .object({
    layout: z.enum(['auto', 'custom']),
    // a picture across the whole width behind the section, with a tint so the text stays readable
    background: z.object({ image: str(), position: z.enum(POSITIONS), overlay: z.number().int().min(0).max(80), tone: z.enum(['dark', 'light', 'brand']) }).partial().strict().nullable(),
    // a softer picture behind the content block inside the section
    backdrop: z.object({ image: str(), opacity: z.number().int().min(5).max(100), blur: z.boolean() }).partial().strict().nullable(),
    pictures: z.array(mediaPicture).max(12)
  })
  .partial()
  .strict();
const mediaSchema = z.object({ home: sectionMedia, about: sectionMedia, academics: sectionMedia, admissions: sectionMedia, news: sectionMedia, gallery: sectionMedia, contact: sectionMedia }).partial().strict();
const draftSchema = z
  .object({
    sections: sectionToggle.optional(),
    home: z.object({ hero: z.object({ image: str(), headline: str(120), subline: str(240), buttonLabel: str(30) }).partial().strict().optional(), highlights: z.array(z.object({ title: str(60), text: str(240), image: str().optional() }).strict()).max(6).optional(), show: z.object({ news: z.boolean(), gallery: z.boolean(), welcome: z.boolean(), stats: z.boolean() }).partial().strict().optional() }).strict().optional(),
    about: z.object({ founded: str(4), history: str(4000), mission: str(4000), vision: str(4000), values: z.array(str(80)).max(10), welcome: z.object({ name: str(80), title: str(60), photo: str(), message: str(3000) }).partial().strict(), facilities: z.array(z.object({ name: str(80), image: str(), text: str(300) }).strict()).max(12) }).partial().strict().optional(),
    academics: z.object({ intro: str(4000), levels: z.array(z.object({ name: str(60), text: str(400) }).strict()).max(20), showSubjects: z.boolean() }).partial().strict().optional(),
    admissions: z.object({ intro: str(4000), steps: z.array(str(240)).max(10), requirements: z.array(str(120)).max(15), showFees: z.boolean(), feesNote: str(400) }).partial().strict().optional(),
    staff: z.object({ show: z.boolean(), people: z.array(z.object({ name: str(80), role: str(80), photo: str() }).strict()).max(40) }).partial().strict().optional(),
    contact: z.object({ address: str(300), phones: z.array(str(20)).max(4), email: str(120), mapLat: z.number().min(-90).max(90).nullable(), mapLng: z.number().min(-180).max(180).nullable(), hours: str(120), social: z.object({ facebook: str(200), instagram: str(200), whatsapp: str(200), x: str(200) }).partial().strict() }).partial().strict().optional(),
    seo: z.object({ title: str(70), description: str(200), shareImage: str() }).partial().strict().optional(),
    testimonials: z.array(z.object({ name: str(80), role: str(80), quote: str(500), photo: str() }).partial().strict()).max(12).optional(),
    faqs: z.array(z.object({ q: str(160), a: str(1200) }).partial().strict()).max(12).optional(),
    media: mediaSchema.optional()
  })
  .strict();

r.patch('/website/draft', { access: MANAGE, body: draftSchema, summary: 'Save part of the draft, one section at a time' }, async (req) => ok(await web.saveDraft(req.body)));
r.get('/website/checks', { access: VIEW, inactiveOk: true, summary: 'What still blocks publishing, and colour warnings' }, async () => ok(await web.checkPublish()));
r.post('/website/preview-token', { access: MANAGE, inactiveOk: true, summary: 'A short-lived token that lets the preview render the draft' }, async () => ok(web.previewToken()));
r.post('/website/publish', { access: { perm: 'website.publish' }, requireActive: true, summary: 'Publish the draft' }, async () => ok(await web.publish()));
r.post('/website/unpublish', { access: { perm: 'website.publish' }, summary: 'Take the site offline' }, async () => ok(await web.unpublish()));

const postBody = z.object({ kind: z.enum(['news', 'event']).default('news'), title: name(160), body: str(8000).optional(), image: str().optional(), eventDate: dateStr.optional(), published: z.boolean().default(false) }).strict();
r.get('/website/posts', { access: VIEW, summary: 'List news and events, including unpublished' }, async () => ok((await Post.find({}).sort({ createdAt: -1 }).limit(200).lean()).map((p: any) => web.postView(p))));
r.post('/website/posts', { access: MANAGE, body: postBody, summary: 'Create a post' }, async (req) => created(web.postView(await web.createPost(req.body))));
r.patch('/website/posts/:id', { access: MANAGE, params: idParam, body: postBody.partial().strict(), summary: 'Edit, publish or unpublish a post' }, async (req) => ok(web.postView(await web.updatePost(req.params.id as string, req.body))));
r.delete('/website/posts/:id', { access: MANAGE, params: idParam, summary: 'Delete a post' }, async (req) => {
  const res = await Post.deleteOne({ _id: req.params.id });
  if (!res.deletedCount) throw notFound('Post');
  return noContent();
});

r.get('/website/gallery', { access: VIEW, summary: 'List gallery items' }, async () => ok((await GalleryItem.find({}).sort({ order: 1 }).lean()).map(web.galleryView)));
r.post('/website/gallery', { access: MANAGE, body: z.object({ image: str().min(10), caption: str(160).optional() }).strict(), summary: 'Add an image' }, async (req) => created(web.galleryView(await web.addGalleryItem(req.body))));
r.put('/website/gallery/order', { access: MANAGE, body: z.object({ ids: z.array(objectId).max(100) }).strict(), summary: 'Reorder the gallery' }, async (req) => {
  await web.reorderGallery(req.body.ids);
  return ok({ ok: true });
});
r.patch('/website/gallery/:id', { access: MANAGE, params: idParam, body: z.object({ caption: str(160) }).strict(), summary: 'Edit a caption' }, async (req) => {
  const g = await need(GalleryItem.findById(req.params.id), 'Image');
  g.caption = req.body.caption;
  await g.save();
  return ok(web.galleryView(g));
});
r.delete('/website/gallery/:id', { access: MANAGE, params: idParam, summary: 'Remove an image' }, async (req) => {
  const res = await GalleryItem.deleteOne({ _id: req.params.id });
  if (!res.deletedCount) throw notFound('Image');
  return noContent();
});

r.get('/enquiries', { access: { perm: 'enquiries.view' }, query: z.object({ ...pageQuery, status: z.enum(['new', 'read', 'handled']).optional() }).strict(), summary: 'Enquiries from the website' }, async (req) => {
  const q = req.query as any;
  const filter: any = q.status ? { status: q.status } : {};
  const p = paging(q, ['createdAt'], '-createdAt');
  const [rows, total] = await Promise.all([Enquiry.find(filter).sort(p.sort).skip(p.skip).limit(p.limit).lean(), Enquiry.countDocuments(filter)]);
  return list(rows.map((e: any) => ({ id: String(e._id), name: e.name, phone: e.phone, email: e.email, message: e.message, status: e.status, createdAt: e.createdAt })), { page: p.page, limit: p.limit, total });
});
r.patch('/enquiries/:id', { access: { perm: 'enquiries.manage' }, params: idParam, body: z.object({ status: z.enum(['new', 'read', 'handled']) }).strict(), summary: 'Mark as read or handled' }, async (req) => {
  const e = await need(Enquiry.findById(req.params.id), 'Enquiry');
  e.status = req.body.status;
  await e.save();
  return ok({ id: String(e._id), status: e.status });
});

// ------------------------------------------------------------------ platform: template versions and takedown

r.get('/platform/template-versions', { access: { perm: 'platform.template.manage' }, summary: 'List website template versions' }, async () => ok(await web.templateVersions()));
r.post('/platform/template-versions', { access: { perm: 'platform.template.manage' }, body: z.object({ version: z.number().int().min(1), notes: str(500).optional() }).strict(), summary: 'Register a template version' }, async (req) => created(await web.createTemplateVersion(req.body)));
r.post('/platform/template-versions/:v/release', { access: { perm: 'platform.template.manage' }, params: z.object({ v: z.coerce.number().int().min(1) }).strict(), summary: 'Make a version current for all schools' }, async (req) => ok(await web.releaseTemplateVersion(Number(req.params.v))));

r.get('/platform/sites/feed', { access: { perm: 'platform.sites.manage' }, summary: 'Recently published or changed school sites' }, async () => ok(await web.sitesFeed()));
r.post('/platform/sites/:schoolId/takedown', { access: { perm: 'platform.sites.manage' }, params: z.object({ schoolId: objectId }).strict(), body: z.object({ reason: text(500).min(3, 'Give a reason.') }).strict(), summary: 'Take a site down with a reason' }, async (req) => ok(await web.takeDownSite(req.params.schoolId as string, req.body.reason)));
r.post('/platform/sites/:schoolId/restore', { access: { perm: 'platform.sites.manage' }, params: z.object({ schoolId: objectId }).strict(), summary: 'Allow the school to publish again' }, async (req) => ok(await web.restoreSite(req.params.schoolId as string)));

export { audit };
