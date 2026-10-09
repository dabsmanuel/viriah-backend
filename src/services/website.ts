import jwt from 'jsonwebtoken';
import { env, isTest } from '../config/env';
import { audit } from '../core/audit';
import { asPlatform, getCtx } from '../core/context';
import { AppError, notFound, stateConflict, validation } from '../core/errors';
import { assertTransition } from '../core/states';
import { me } from '../core/http';
import { cleanRichText, cleanText } from '../core/sanitize';
import { brandTokens } from '../calc/contrast';
import { publicUrl } from '../integrations/storage';
import { logger } from '../core/logger';
import { schoolLink } from '../lib/links';
import { Enquiry, GalleryItem, Post, School, Site, TemplateVersion, ClassLevel, Student, Staff, ClassArm, Term, AdmissionSettings } from '../models';
import { currentSession } from './reach';
import { confirmFile } from './files';
import { adminRecipients, need } from './common';
import { notify } from './notify';
import { computeSetupProgress } from './setup';

/**
 * The website engine (Document 3, section 10; WEB-01 to WEB-15). One master template is rendered for every school with the
 * school's brand settings and content. Schools fill in forms; the layout cannot be changed. Draft and published versions are
 * separate. Sites are built for phones and slow connections first.
 */

export const SECTIONS = ['home', 'about', 'academics', 'admissions', 'news', 'gallery', 'staff', 'contact'] as const;
export type SectionKey = (typeof SECTIONS)[number];

/** Fields that hold default text until the school writes its own. Publishing is blocked while one remains in an enabled section. */
const PLACEHOLDER_PATHS: Array<{ path: string; section: SectionKey; label: string }> = [
  { path: 'home.hero.headline', section: 'home', label: 'Home page headline' },
  { path: 'home.hero.subline', section: 'home', label: 'Home page subheading' },
  { path: 'home.highlights', section: 'home', label: 'Home page highlights' },
  { path: 'about.history', section: 'about', label: 'About: our story' },
  { path: 'about.mission', section: 'about', label: 'About: mission' },
  { path: 'about.vision', section: 'about', label: 'About: vision' },
  { path: 'about.welcome.message', section: 'about', label: 'Head’s welcome message' },
  { path: 'academics.intro', section: 'academics', label: 'Academics introduction' },
  { path: 'admissions.intro', section: 'admissions', label: 'Admissions introduction' },
  { path: 'admissions.steps', section: 'admissions', label: 'How to apply' },
  { path: 'admissions.requirements', section: 'admissions', label: 'What to bring' }
];

type Json = Record<string, any>;

export function defaultContent(school: any): Json {
  return {
    sections: { home: true, about: true, academics: true, admissions: true, news: true, gallery: true, staff: false, contact: true },
    home: {
      hero: { image: '', headline: `Welcome to ${school.name}`, subline: 'Add a short line about your school here.', buttonLabel: 'Apply now' },
      highlights: [
        { title: 'Caring teachers', text: 'Replace this text with what makes your school special.' },
        { title: 'A safe place to learn', text: 'Replace this text with what makes your school special.' },
        { title: 'Strong results', text: 'Replace this text with what makes your school special.' }
      ],
      show: { news: true, gallery: true, welcome: true, stats: true }
    },
    about: {
      history: 'Tell parents how the school began and where it is today.',
      mission: 'Write the school’s mission here.',
      vision: 'Write the school’s vision here.',
      values: [],
      founded: '',
      welcome: { name: '', title: 'Head teacher', photo: '', message: 'Write a short welcome from the head of the school.' },
      facilities: []
    },
    academics: { intro: 'Describe how the school teaches and what pupils learn.', levels: [], showSubjects: true },
    admissions: {
      intro: 'Explain how to apply to the school.',
      steps: ['Fill in the application form on this page.', 'The school reviews the application and may invite your child for a short test.', 'If your child is offered a place, pay the acceptance fee to confirm it.'],
      requirements: ['Birth certificate', 'Last school report', 'A passport photograph'],
      showFees: false,
      feesNote: ''
    },
    staff: { show: false, people: [] },
    testimonials: [],
    faqs: [],
    contact: { address: [school.address?.street, school.address?.town, school.address?.state].filter(Boolean).join(', '), phones: school.phone ? [school.phone] : [], email: school.email ?? '', mapLat: null, mapLng: null, hours: 'Monday to Friday, 8:00am to 4:00pm', social: { facebook: '', instagram: '', whatsapp: '', x: '' } },
    seo: { title: '', description: '', shareImage: '' }
  };
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}
const getPath = (o: Json, path: string) => path.split('.').reduce((a: any, k) => (a == null ? undefined : a[k]), o);

/** Stored content layered over the defaults, so a school with only a name, logo and colours still has a complete-looking site. */
export function effectiveContent(school: any, stored: Json | undefined | null): Json {
  return deepMerge(defaultContent(school), stored ?? {});
}

/** Paths that still hold the default text, in sections that are switched on. */
export function placeholdersOf(school: any, content: Json): Array<{ path: string; label: string }> {
  const defaults = defaultContent(school);
  return PLACEHOLDER_PATHS.filter((p) => content.sections?.[p.section] !== false && JSON.stringify(getPath(content, p.path)) === JSON.stringify(getPath(defaults, p.path))).map((p) => ({ path: p.path, label: p.label }));
}

async function siteDoc(createIfMissing = true) {
  let s: any = await Site.findOne({});
  if (!s && createIfMissing) s = await Site.create({ status: 'draft', draft: {}, templateVersion: (await currentTemplateVersion()) });
  return s;
}

export async function currentTemplateVersion(): Promise<number> {
  const v: any = await asPlatform(() => TemplateVersion.findOne({ isCurrent: true }).lean());
  return v?.version ?? 1;
}

// ------------------------------------------------------------------ editor

export async function websiteForEditor() {
  const school: any = await need(School.findById(getCtx()!.schoolId).lean(), 'School');
  const site = await siteDoc();
  const draft = effectiveContent(school, site.draft);
  const published = site.published ? effectiveContent(school, site.published) : null;
  return {
    status: site.status,
    templateVersion: site.templateVersion,
    publishedAt: site.publishedAt,
    takedown: site.status === 'taken_down' ? site.takedown : undefined,
    draft,
    draftUrls: resolveImages(draft), // the same content with picture references turned into links, so the editor can show them
    published,
    placeholders: placeholdersOf(school, draft),
    brand: brandView(school),
    hasUnpublishedChanges: !!published && JSON.stringify(stripSections(site.draft ?? {})) !== JSON.stringify(stripSections(site.published ?? {}))
  };
}
const stripSections = (x: Json) => x;

const brandView = (school: any) => ({ name: school.name, motto: school.motto, logo: publicUrl(school.branding?.logo), favicon: publicUrl(school.branding?.favicon), primary: school.branding?.primary, secondary: school.branding?.secondary, tokens: brandTokens(school.branding?.primary, school.branding?.secondary) });


const MEDIA_SECTIONS = ['home', 'about', 'academics', 'admissions', 'news', 'gallery', 'contact'] as const;

/** Every picture reference in a draft or patch (media, highlights), so new ones can be confirmed and stored ones turned into links. */
function mediaRefs(c: Json): string[] {
  const out: string[] = [];
  for (const k of MEDIA_SECTIONS) {
    const m = c?.media?.[k];
    if (m?.background?.image) out.push(m.background.image);
    if (m?.backdrop?.image) out.push(m.backdrop.image);
    for (const pic of m?.pictures ?? []) if (pic?.image) out.push(pic.image);
  }
  for (const h of c?.home?.highlights ?? []) if (h?.image) out.push(h.image);
  for (const x of c?.testimonials ?? []) if (x?.photo) out.push(x.photo);
  return out;
}

const IMAGE_PATHS = ['home.hero.image', 'about.welcome.photo', 'seo.shareImage'];

/** Save part of the draft, one section at a time. Text is cleaned on the server; images must exist in the school's folder. */
export async function saveDraft(patch: Json) {
  const school: any = await need(School.findById(getCtx()!.schoolId).lean(), 'School');
  const site = await siteDoc();
  if (site.status === 'taken_down') throw stateConflict('This site was taken down by the platform. You can edit the draft, but not publish until it is restored.');
  const clean = cleanPatch(patch);
  // Images: a new reference must exist in this school's public image folder.
  for (const p of IMAGE_PATHS) {
    const v = getPath(clean, p);
    if (typeof v === 'string' && v && v !== getPath(site.draft ?? {}, p)) await confirmFile(v, 'site_image');
  }
  const knownRefs = new Set(mediaRefs(site.draft ?? {}));
  for (const ref of new Set(mediaRefs(clean))) if (!knownRefs.has(ref)) await confirmFile(ref, 'site_image');
  for (const key of ['facilities', 'people'] as const) {
    const list = key === 'facilities' ? clean.about?.facilities : clean.staff?.people;
    const before = key === 'facilities' ? site.draft?.about?.facilities : site.draft?.staff?.people;
    for (const item of list ?? []) {
      const field = key === 'facilities' ? item.image : item.photo;
      if (field && !(before ?? []).some((b: any) => (b.image ?? b.photo) === field)) await confirmFile(field, 'site_image');
    }
  }
  const merged = deepMergeReplacingArrays(site.draft ?? {}, clean);
  site.draft = merged;
  site.markModified('draft');
  await site.save();
  const effective = effectiveContent(school, merged);
  return { draft: effective, placeholders: placeholdersOf(school, effective) };
}

function deepMergeReplacingArrays(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? deepMergeReplacingArrays(base[k], v) : v;
  return out;
}

const SHORT = 160;
/** Plain text for short fields. A small set of formatting (bold, lists, links) for longer ones. No HTML, scripts or embeds. */
function cleanPatch(p: Json): Json {
  const t = (s: unknown, max = SHORT) => cleanText(String(s ?? '')).slice(0, max);
  const rich = (s: unknown, max = 4000) => cleanRichText(String(s ?? '')).slice(0, max);
  const out: Json = {};
  if (p.sections) out.sections = Object.fromEntries(SECTIONS.filter((s) => typeof p.sections[s] === 'boolean').map((s) => [s, p.sections[s]]));
  if (p.home) {
    out.home = {};
    if (p.home.hero) out.home.hero = { ...(p.home.hero.image !== undefined ? { image: String(p.home.hero.image) } : {}), ...(p.home.hero.headline !== undefined ? { headline: t(p.home.hero.headline, 120) } : {}), ...(p.home.hero.subline !== undefined ? { subline: t(p.home.hero.subline, 240) } : {}), ...(p.home.hero.buttonLabel !== undefined ? { buttonLabel: t(p.home.hero.buttonLabel, 30) } : {}) };
    if (p.home.highlights) out.home.highlights = p.home.highlights.slice(0, 6).map((h: any) => ({ title: t(h.title, 60), text: t(h.text, 240), image: String(h.image ?? '') }));
    if (p.home.show) out.home.show = { news: !!p.home.show.news, gallery: !!p.home.show.gallery, welcome: !!p.home.show.welcome, stats: p.home.show.stats !== false };
  }
  if (p.about) {
    out.about = {};
    for (const k of ['history', 'mission', 'vision'] as const) if (p.about[k] !== undefined) out.about[k] = rich(p.about[k]);
    if (p.about.founded !== undefined) out.about.founded = /^\d{4}$/.test(String(p.about.founded).trim()) ? String(p.about.founded).trim() : '';
    if (p.about.values) out.about.values = p.about.values.slice(0, 10).map((v: any) => t(v, 80));
    if (p.about.welcome) out.about.welcome = { ...(p.about.welcome.name !== undefined ? { name: t(p.about.welcome.name, 80) } : {}), ...(p.about.welcome.title !== undefined ? { title: t(p.about.welcome.title, 60) } : {}), ...(p.about.welcome.photo !== undefined ? { photo: String(p.about.welcome.photo) } : {}), ...(p.about.welcome.message !== undefined ? { message: rich(p.about.welcome.message, 3000) } : {}) };
    if (p.about.facilities) out.about.facilities = p.about.facilities.slice(0, 12).map((f: any) => ({ name: t(f.name, 80), image: String(f.image ?? ''), text: t(f.text, 300) }));
  }
  if (p.academics) {
    out.academics = {};
    if (p.academics.intro !== undefined) out.academics.intro = rich(p.academics.intro);
    if (p.academics.levels) out.academics.levels = p.academics.levels.slice(0, 20).map((l: any) => ({ name: t(l.name, 60), text: t(l.text, 400) }));
    if (p.academics.showSubjects !== undefined) out.academics.showSubjects = !!p.academics.showSubjects;
  }
  if (p.admissions) {
    out.admissions = {};
    if (p.admissions.intro !== undefined) out.admissions.intro = rich(p.admissions.intro);
    if (p.admissions.steps) out.admissions.steps = p.admissions.steps.slice(0, 10).map((s: any) => t(s, 240));
    if (p.admissions.requirements) out.admissions.requirements = p.admissions.requirements.slice(0, 15).map((s: any) => t(s, 120));
    if (p.admissions.showFees !== undefined) out.admissions.showFees = !!p.admissions.showFees;
    if (p.admissions.feesNote !== undefined) out.admissions.feesNote = t(p.admissions.feesNote, 400);
  }
  if (p.staff) {
    out.staff = {};
    if (p.staff.show !== undefined) out.staff.show = !!p.staff.show;
    if (p.staff.people) out.staff.people = p.staff.people.slice(0, 40).map((x: any) => ({ name: t(x.name, 80), role: t(x.role, 80), photo: String(x.photo ?? '') }));
  }
  if (p.contact) {
    out.contact = {};
    if (p.contact.address !== undefined) out.contact.address = t(p.contact.address, 300);
    if (p.contact.phones) out.contact.phones = p.contact.phones.slice(0, 4).map((x: any) => t(x, 20));
    if (p.contact.email !== undefined) out.contact.email = t(p.contact.email, 120);
    if (p.contact.mapLat !== undefined) out.contact.mapLat = p.contact.mapLat;
    if (p.contact.mapLng !== undefined) out.contact.mapLng = p.contact.mapLng;
    if (p.contact.hours !== undefined) out.contact.hours = t(p.contact.hours, 120);
    if (p.contact.social) {
      out.contact.social = {};
      for (const k of ['facebook', 'instagram', 'whatsapp', 'x'] as const) if (p.contact.social[k] !== undefined) out.contact.social[k] = safeUrl(p.contact.social[k]);
    }
  }
  if (p.testimonials) out.testimonials = p.testimonials.slice(0, 12).map((x: any) => ({ name: t(x.name, 80), role: t(x.role, 80), quote: t(x.quote, 500), photo: String(x.photo ?? '') }));
  if (p.faqs) out.faqs = p.faqs.slice(0, 12).map((x: any) => ({ q: t(x.q, 160), a: rich(x.a, 1200) }));
  if (p.media) {
    out.media = {};
    const POS = ['center', 'top', 'bottom', 'left', 'right'];
    const PLACE = ['left', 'right', 'top', 'bottom', 'full', 'grid'];
    const SIZE = ['small', 'medium', 'large'];
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
    for (const key of MEDIA_SECTIONS) {
      const m = p.media[key];
      if (m === undefined) continue;
      const o: Json = {};
      if (m.layout !== undefined) o.layout = m.layout === 'custom' ? 'custom' : 'auto';
      if (m.background !== undefined) o.background = m.background && m.background.image ? { image: String(m.background.image), position: POS.includes(m.background.position) ? m.background.position : 'center', overlay: num(m.background.overlay, 0, 80, 45), tone: ['dark', 'light', 'brand'].includes(m.background.tone) ? m.background.tone : 'dark' } : null;
      if (m.backdrop !== undefined) o.backdrop = m.backdrop && m.backdrop.image ? { image: String(m.backdrop.image), opacity: num(m.backdrop.opacity, 5, 100, 25), blur: !!m.backdrop.blur } : null;
      if (m.pictures !== undefined) o.pictures = (m.pictures ?? []).slice(0, 12).filter((x: any) => x?.image).map((x: any) => ({ image: String(x.image), caption: t(x.caption ?? '', 160), placement: PLACE.includes(x.placement) ? x.placement : 'grid', size: SIZE.includes(x.size) ? x.size : 'medium' }));
      out.media[key] = o;
    }
  }
  if (p.seo) out.seo = { ...(p.seo.title !== undefined ? { title: t(p.seo.title, 70) } : {}), ...(p.seo.description !== undefined ? { description: t(p.seo.description, 200) } : {}), ...(p.seo.shareImage !== undefined ? { shareImage: String(p.seo.shareImage) } : {}) };
  return out;
}

function safeUrl(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.slice(0, 200);
  if (/^[a-z0-9_.\-/]+$/i.test(s)) return s.slice(0, 200); // a handle or number
  return '';
}

// ------------------------------------------------------------------ checks, publish, unpublish

export interface PublishCheck {
  canPublish: boolean;
  blocking: Array<{ path?: string; message: string }>;
  warnings: string[];
}

/** What still blocks publishing, and colour warnings (WEB-06). */
export async function checkPublish(): Promise<PublishCheck> {
  const school: any = await need(School.findById(getCtx()!.schoolId).lean(), 'School');
  const site = await siteDoc();
  const content = effectiveContent(school, site.draft);
  const blocking: PublishCheck['blocking'] = [];
  if (school.status !== 'active') blocking.push({ message: school.status === 'pending' ? 'The school is waiting for approval. You can publish when it is approved.' : 'The school is not active.' });
  if (site.status === 'taken_down') blocking.push({ message: 'The platform took this site down. It cannot be published until the platform lifts that.' });
  const setup = await computeSetupProgress();
  for (const m of setup.website.missing) blocking.push({ message: `Finish setup first: ${m.title}.` });
  for (const p of placeholdersOf(school, content)) blocking.push({ path: p.path, message: `${p.label} still has the sample text. Write your own, or switch that section off.` });
  if (!school.branding?.logo) blocking.push({ path: 'brand.logo', message: 'Add your logo.' });
  if (content.sections.contact !== false && !content.contact.phones.length && !content.contact.email) blocking.push({ path: 'contact', message: 'Add a phone number or an email address to the contact page.' });
  const tokens = brandTokens(school.branding?.primary, school.branding?.secondary);
  return { canPublish: blocking.length === 0, blocking, warnings: tokens.warnings };
}

export async function publish() {
  const c = me();
  const check = await checkPublish();
  if (!check.canPublish) throw new AppError('state_conflict', 'The site cannot be published yet.', { details: { blocking: check.blocking } });
  const site = await siteDoc();
  // Publishing again while live just replaces the published copy: later edits wait in the draft until Publish is pressed.
  if (site.status !== 'published') assertTransition('website', site.status, 'published', 'This site');
  const school: any = await School.findById(c.schoolId).lean();
  site.published = effectiveContent(school, site.draft);
  site.status = 'published';
  site.publishedAt = new Date();
  site.publishedBy = c.userId;
  site.templateVersion = await currentTemplateVersion();
  site.markModified('published');
  await site.save();
  await audit({ action: 'website.publish', entityType: 'site', entityId: site._id });
  await revalidate(school.slug);
  return { status: site.status, publishedAt: site.publishedAt };
}

export async function unpublish() {
  const site = await siteDoc();
  assertTransition('website', site.status, 'unpublished', 'This site');
  site.status = 'unpublished';
  await site.save();
  const school: any = await School.findById(getCtx()!.schoolId).select('slug').lean();
  await audit({ action: 'website.unpublish', entityType: 'site', entityId: site._id });
  await revalidate(school.slug);
  return { status: site.status };
}

/** Publishing asks the web application to refresh that school's cached pages, so they change within seconds. */
export async function revalidate(slug: string) {
  if (isTest) return;
  try {
    await fetch(`${env.WEB_ORIGIN}/api/revalidate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-revalidate-secret': env.REVALIDATE_SECRET }, body: JSON.stringify({ tag: `school:${slug}` }), signal: AbortSignal.timeout(3000) });
  } catch (e) {
    logger.debug({ err: (e as Error).message }, 'revalidate skipped');
  }
}

// ------------------------------------------------------------------ preview

export function previewToken(): { token: string; expiresInMinutes: number } {
  const c = me();
  return { token: jwt.sign({ typ: 'preview', sid: c.schoolId }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' }), expiresInMinutes: 15 };
}

function validPreview(token?: string): boolean {
  if (!token) return false;
  try {
    const c = jwt.verify(token, env.JWT_ACCESS_SECRET) as { typ: string; sid: string };
    return c.typ === 'preview' && c.sid === getCtx()?.schoolId;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ public rendering

const URL_FIELDS = ['home.hero.image', 'about.welcome.photo', 'seo.shareImage'];

function resolveImages(content: Json): Json {
  const c = JSON.parse(JSON.stringify(content));
  for (const p of URL_FIELDS) {
    const parts = p.split('.');
    const last = parts.pop()!;
    const parent = parts.reduce((a: any, k) => a?.[k], c);
    if (parent && parent[last]) parent[last] = publicUrl(parent[last]);
  }
  for (const k of MEDIA_SECTIONS) {
    const m = c.media?.[k];
    if (!m) continue;
    if (m.background?.image) m.background.image = publicUrl(m.background.image);
    if (m.backdrop?.image) m.backdrop.image = publicUrl(m.backdrop.image);
    for (const pic of m.pictures ?? []) if (pic.image) pic.image = publicUrl(pic.image);
  }
  for (const h of c.home?.highlights ?? []) if (h.image) h.image = publicUrl(h.image);
  for (const x of c.testimonials ?? []) if (x.photo) x.photo = publicUrl(x.photo);
  for (const f of c.about?.facilities ?? []) if (f.image) f.image = publicUrl(f.image);
  for (const s of c.staff?.people ?? []) if (s.photo) s.photo = publicUrl(s.photo);
  return c;
}

/** A section with no content is hidden automatically, so the site never shows empty blocks. */
function visibleSections(content: Json, extra: { hasPosts: boolean; hasGallery: boolean; hasLevels: boolean }): Record<SectionKey, boolean> {
  const on = (k: SectionKey) => content.sections?.[k] !== false;
  return {
    home: on('home'),
    about: on('about') && !!(content.about.history || content.about.mission || content.about.vision || content.about.welcome?.message),
    academics: on('academics') && !!(content.academics.intro || content.academics.levels.length || extra.hasLevels),
    admissions: on('admissions'),
    news: on('news') && extra.hasPosts,
    gallery: on('gallery') && extra.hasGallery,
    staff: on('staff') && !!content.staff.show && content.staff.people.length > 0,
    contact: on('contact') && !!(content.contact.address || content.contact.phones.length || content.contact.email)
  };
}

export async function publicSite(previewTokenValue?: string) {
  const school: any = await need(School.findById(getCtx()!.schoolId).lean(), 'School');
  // A suspended or taken-down school renders a single neutral page with status 503 and no indexing.
  if (school.status === 'suspended' || school.status === 'closed') return { neutral: true as const, reason: 'suspended' };
  const site: any = await Site.findOne({}).lean();
  if (site?.status === 'taken_down') return { neutral: true as const, reason: 'taken_down' };
  const previewing = validPreview(previewTokenValue);
  if (!previewing && (!site || site.status !== 'published' || school.status !== 'active')) throw notFound('Website');

  const content = effectiveContent(school, previewing ? site?.draft : site.published);
  const [hasPosts, hasGallery, levels] = await Promise.all([Post.exists({ published: true }), GalleryItem.exists({}), ClassLevel.find({ active: true }).sort({ order: 1 }).select('name').lean()]);
  const sections = visibleSections(content, { hasPosts: !!hasPosts, hasGallery: !!hasGallery, hasLevels: levels.length > 0 });
  const tokens = brandTokens(school.branding?.primary, school.branding?.secondary);
  const resolved = resolveImages(content);
  const facts = await publicFacts(levels);
  const canonical = schoolLink(school.slug, '/');
  return {
    neutral: false as const,
    preview: previewing,
    status: previewing ? 'preview' : 'published',
    templateVersion: previewing ? await currentTemplateVersion() : site.templateVersion,
    brand: { name: school.name, motto: school.motto, logo: publicUrl(school.branding?.logo), favicon: publicUrl(school.branding?.favicon), primary: tokens.primary, secondary: tokens.secondary, tokens },
    sections,
    facts,
    content: { ...resolved, academics: { ...resolved.academics, levels: resolved.academics.levels.length ? resolved.academics.levels : levels.map((l: any) => ({ name: l.name, text: '' })) } },
    school: { slug: school.slug, address: school.address, portalUrl: schoolLink(school.slug, '/portal'), showFees: !!content.admissions.showFees },
    seo: { title: content.seo.title || `${school.name}${school.address?.town ? `, ${school.address.town}` : ''}`, description: content.seo.description || cleanText(content.home.hero.subline).slice(0, 160), shareImage: resolved.seo.shareImage || resolved.home.hero.image || publicUrl(school.branding?.logo), canonical, noindex: previewing },
    structuredData: { '@context': 'https://schema.org', '@type': 'School', name: school.name, url: canonical, logo: publicUrl(school.branding?.logo), telephone: content.contact.phones[0], email: content.contact.email, address: { '@type': 'PostalAddress', streetAddress: school.address?.street, addressLocality: school.address?.town, addressRegion: school.address?.state, addressCountry: 'NG' } }
  };
}

/**
 * Real numbers about the school for the public page, taken from its records: how many pupils and teachers, which classes,
 * the dates of the current session's terms, and whether applications are open. Counts only, never names.
 */
async function publicFacts(levels: any[]) {
  const [pupils, teachers, arms, session] = await Promise.all([
    Student.countDocuments({ status: 'active' }),
    Staff.countDocuments({ status: 'active', roles: { $in: ['class_teacher', 'subject_teacher'] } }),
    ClassArm.countDocuments({ active: true }),
    currentSession().catch(() => null) as Promise<any>
  ]);
  let terms: any[] = [];
  let admissions: { open: boolean; session?: string } = { open: false };
  if (session) {
    terms = (await Term.find({ sessionId: session._id }).sort({ number: 1 }).select('number startDate endDate nextTermBegins').lean()).map((x: any) => ({ number: x.number, startDate: x.startDate, endDate: x.endDate, nextTermBegins: x.nextTermBegins }));
    const open: any = await AdmissionSettings.findOne({ sessionId: session._id }).select('open').lean();
    admissions = { open: !!open?.open, session: session.name };
  }
  return { pupils, teachers, classes: arms, levels: levels.map((l: any) => l.name), session: session?.name ?? null, terms, admissions };
}

export async function publicSitemap() {
  const school: any = await need(School.findById(getCtx()!.schoolId).lean(), 'School');
  const site: any = await Site.findOne({}).lean();
  if (!site || site.status !== 'published' || school.status !== 'active') throw notFound('Website');
  const posts: any[] = await Post.find({ published: true }).sort({ createdAt: -1 }).limit(200).select('updatedAt').lean();
  const base = (p: string, lastmod?: Date) => ({ url: schoolLink(school.slug, p), lastmod: (lastmod ?? site.publishedAt)?.toISOString?.().slice(0, 10) });
  return [base('/', site.publishedAt), base('/about'), base('/academics'), base('/admissions'), base('/news'), base('/gallery'), base('/contact'), ...posts.map((p) => base(`/news/${p._id}`, p.updatedAt))];
}

// ------------------------------------------------------------------ posts, gallery, enquiries

export async function createPost(input: { kind: 'news' | 'event'; title: string; body?: string; image?: string; eventDate?: string; published?: boolean }) {
  if (input.image) await confirmFile(input.image, 'site_image');
  return Post.create({ ...input, title: cleanText(input.title).slice(0, 160), body: cleanRichText(input.body ?? '').slice(0, 8000) });
}
export async function updatePost(id: string, patch: Partial<{ kind: 'news' | 'event'; title: string; body: string; image: string; eventDate: string; published: boolean }>) {
  const p: any = await need(Post.findById(id), 'Post');
  if (patch.image && patch.image !== p.image) await confirmFile(patch.image, 'site_image');
  if (patch.title !== undefined) patch.title = cleanText(patch.title).slice(0, 160);
  if (patch.body !== undefined) patch.body = cleanRichText(patch.body).slice(0, 8000);
  Object.assign(p, patch);
  await p.save();
  return p;
}

export const postView = (p: any, full = true) => ({ id: String(p._id), kind: p.kind, title: p.title, ...(full ? { body: p.body } : { excerpt: cleanText(p.body ?? '').slice(0, 180) }), image: publicUrl(p.image), imageRef: p.image, eventDate: p.eventDate, published: p.published, createdAt: p.createdAt });

export async function addGalleryItem(input: { image: string; caption?: string }) {
  await confirmFile(input.image, 'site_image');
  const count = await GalleryItem.countDocuments({});
  if (count >= 100) throw validation('The gallery is full. Remove an image to add another.');
  return GalleryItem.create({ image: input.image, caption: cleanText(input.caption ?? '').slice(0, 160), order: count });
}

export async function reorderGallery(ids: string[]) {
  const items: any[] = await GalleryItem.find({}).lean();
  if (items.length !== ids.length || !items.every((i) => ids.includes(String(i._id)))) throw validation('Send every gallery image once, in the order you want.', { ids: 'Must list every image.' });
  await Promise.all(ids.map((id, i) => GalleryItem.updateOne({ _id: id }, { order: i })));
}

export const galleryView = (g: any) => ({ id: String(g._id), image: publicUrl(g.image), imageRef: g.image, caption: g.caption, order: g.order });

/** Enquiries land in an inbox in the school portal and notify the school admin. A hidden field catches simple bots. */
export async function receiveEnquiry(input: { name: string; phone?: string; email?: string; message: string; website?: string }, ip?: string) {
  if (input.website) return { received: true }; // honeypot: a person never fills this
  if (!input.phone && !input.email) throw validation('Give a phone number or an email so the school can reply.', { phone: 'Add a phone number or email.' });
  const school: any = await need(School.findById(getCtx()!.schoolId).select('status').lean(), 'School');
  if (school.status !== 'active') throw new AppError('school_not_active', 'This school is not taking messages right now.');
  const doc = await Enquiry.create({ name: cleanText(input.name).slice(0, 80), phone: input.phone, email: input.email, message: cleanText(input.message).slice(0, 2000), ip });
  await notify({ event: 'enquiry_received', to: await adminRecipients(getCtx()!.schoolId!), vars: { name: doc.name } });
  return { received: true, id: String(doc._id) };
}

// ------------------------------------------------------------------ platform: template versions, takedown, feed

export async function templateVersions() {
  return asPlatform(() => TemplateVersion.find({}).sort({ version: -1 }).lean());
}

export async function createTemplateVersion(input: { version: number; notes?: string }) {
  if (await asPlatform(() => TemplateVersion.exists({ version: input.version }))) throw validation('That version already exists.', { version: 'Already exists.' });
  return asPlatform(() => TemplateVersion.create({ ...input, isCurrent: false }));
}

/** Releasing a version switches every site at once. Earlier versions are kept so a release can be rolled back. */
export async function releaseTemplateVersion(version: number) {
  const v: any = await asPlatform(() => TemplateVersion.findOne({ version }));
  if (!v) throw notFound('Template version');
  await asPlatform(async () => {
    await TemplateVersion.updateMany({ isCurrent: true }, { isCurrent: false });
    v.isCurrent = true;
    v.releasedAt = new Date();
    await v.save();
  });
  await audit({ action: 'platform.template.release', entityType: 'templateVersion', entityId: v._id, after: { version } });
  // Every published site moves to the current version at once. The version is read at render time.
  return { version, current: true };
}

export async function takeDownSite(schoolId: string, reason: string) {
  const c = me();
  const school: any = await need(School.findById(schoolId).select('slug name').lean(), 'School');
  const site: any = await need(asPlatform(() => Site.findOne({ schoolId })), 'Site');
  assertTransition('website', site.status, 'taken_down', 'This site');
  await asPlatform(async () => {
    site.status = 'taken_down';
    site.takedown = { reason, by: c.userId, at: new Date() };
    await site.save();
  });
  await audit({ action: 'platform.site.takedown', entityType: 'site', entityId: site._id, schoolId, reason });
  await revalidate(school.slug);
  return { status: 'taken_down' };
}

export async function restoreSite(schoolId: string) {
  const school: any = await need(School.findById(schoolId).select('slug').lean(), 'School');
  const site: any = await need(asPlatform(() => Site.findOne({ schoolId })), 'Site');
  assertTransition('website', site.status, 'unpublished', 'This site');
  await asPlatform(async () => {
    site.status = 'unpublished';
    site.takedown = undefined;
    await site.save();
  });
  await audit({ action: 'platform.site.restore', entityType: 'site', entityId: site._id, schoolId });
  await revalidate(school.slug);
  return { status: 'unpublished' };
}

/** Recently published or changed school sites, for spot checks. */
export async function sitesFeed() {
  const sites: any[] = await asPlatform(() => Site.find({ publishedAt: { $exists: true } }).sort({ updatedAt: -1 }).limit(50).lean());
  const schools = new Map<string, any>((await School.find({ _id: { $in: sites.map((s) => s.schoolId) } }).select('name slug').lean()).map((s: any) => [String(s._id), s]));
  return sites.map((s) => ({ schoolId: String(s.schoolId), school: schools.get(String(s.schoolId))?.name, slug: schools.get(String(s.schoolId))?.slug, status: s.status, publishedAt: s.publishedAt, updatedAt: s.updatedAt, templateVersion: s.templateVersion, url: schoolLink(schools.get(String(s.schoolId))?.slug ?? '', '/') }));
}
