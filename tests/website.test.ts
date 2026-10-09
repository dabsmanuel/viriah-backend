import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, drainJobs, makeStaff, platform, resetDb, signIn, signInSuperAdmin, smsTo, startTestDb, stopTestDb } from './helpers';
import { buildSchool, readyForWebsite, uploadPng } from './fixtures';
import { AuditLog, Notification, Site, TemplateVersion } from '../src/models';
import { ctxFor } from './helpers';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(resetDb);

async function websiteReady() {
  const fx = await buildSchool();
  await readyForWebsite(fx);
  // the checklist needs the school profile, session, classes, subjects and grading, which buildSchool provides
  return fx;
}

const ownText = {
  home: { hero: { headline: 'Learning that lasts', subline: 'A nursery and primary school in Ikeja.' }, highlights: [{ title: 'Small classes', text: 'No more than twenty pupils.' }] },
  about: { history: 'Founded in 1998 by a group of teachers.', mission: 'To teach every child to read well.', vision: 'A school every family trusts.', welcome: { name: 'Mrs Obi', message: 'Welcome to our school.' } },
  academics: { intro: 'We follow the national curriculum with extra reading time.' },
  admissions: { intro: 'Apply online, then visit us for a short chat.', steps: ['Fill in the form', 'Come for a visit'], requirements: ['Birth certificate'] }
};

describe('M6 school website', () => {
  it('gives a school with only a name, logo and colours a complete-looking preview', async () => {
    const fx = await websiteReady();
    const tok = (await fx.oc.post('/website/preview-token').send({})).body.data.token;
    const host = client(fx.host);
    const pre = await host.get(`/public/site?preview=${encodeURIComponent(tok)}`);
    expect(pre.status).toBe(200);
    expect(pre.body.data.preview).toBe(true);
    expect(pre.body.data.content.home.hero.headline).toBe(`Welcome to ${fx.school.name}`);
    expect(pre.body.data.sections).toMatchObject({ home: true, about: true, admissions: true, contact: true, news: false, gallery: false, staff: false });
    expect(pre.headers['x-robots-tag']).toBe('noindex');
    expect(pre.headers['cache-control']).toBe('no-store');
    // the live site is not available yet
    expect((await host.get('/public/site')).status).toBe(404);
    // a made-up or other school's token shows nothing
    expect((await host.get('/public/site?preview=abc')).status).toBe(404);
  });

  it('blocks publishing while sample text remains, lists the fields, then publishes within one call and keeps the live site until the next publish', async () => {
    const fx = await websiteReady();
    const blocked = await fx.oc.post('/website/publish').send({});
    expect(blocked.status).toBe(409);
    const paths = blocked.body.error.details.blocking.map((b: any) => b.path);
    expect(paths).toEqual(expect.arrayContaining(['home.hero.headline', 'about.history', 'admissions.intro']));
    expect((await fx.oc.get('/website/checks')).body.data.canPublish).toBe(false);

    // switching a section off removes its placeholders from the blockers
    await fx.oc.patch('/website/draft').send({ sections: { about: false } });
    const after = (await fx.oc.get('/website/checks')).body.data.blocking.map((b: any) => b.path);
    expect(after).not.toContain('about.history');

    const saved = await fx.oc.patch('/website/draft').send({ ...ownText, sections: { about: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.data.placeholders).toEqual([]);
    const pub = await fx.oc.post('/website/publish').send({});
    expect(pub.status).toBe(200);

    const host = client(fx.host);
    const live = await host.get('/public/site');
    expect(live.status).toBe(200);
    expect(live.body.data.content.home.hero.headline).toBe('Learning that lasts');
    expect(live.body.data.seo.title).toContain(fx.school.name);
    expect(live.body.data.structuredData['@type']).toBe('School');
    expect(live.headers['cache-control']).toContain('max-age');

    // a later draft edit does not change the live site
    await fx.oc.patch('/website/draft').send({ home: { hero: { headline: 'A brand new headline' } } });
    expect((await host.get('/public/site')).body.data.content.home.hero.headline).toBe('Learning that lasts');
    const editor = (await fx.oc.get('/website')).body.data;
    expect(editor.draft.home.hero.headline).toBe('A brand new headline');
    expect(editor.published.home.hero.headline).toBe('Learning that lasts');
    await fx.oc.post('/website/publish').send({});
    expect((await host.get('/public/site')).body.data.content.home.hero.headline).toBe('A brand new headline');
    expect((await platform(() => AuditLog.find({ action: 'website.publish' }).lean())).length).toBe(2);

    // unpublish takes it offline
    expect((await fx.oc.post('/website/unpublish').send({})).status).toBe(200);
    expect((await host.get('/public/site')).status).toBe(404);
  });

  it('keeps pictures for each section (background, backdrop, placed pictures), shows them in the preview before publishing, and refuses a picture from another school', async () => {
    const fx = await websiteReady();
    const hero = await uploadPng(fx.oc, 'site_image');
    const back = await uploadPng(fx.oc, 'site_image');
    const pic = await uploadPng(fx.oc, 'site_image');
    const save = await fx.oc.patch('/website/draft').send({
      media: {
        home: { layout: 'custom', background: { image: hero, position: 'top', overlay: 60, tone: 'brand' } },
        about: { layout: 'auto', backdrop: { image: back, opacity: 30, blur: true }, pictures: [{ image: pic, caption: 'Our assembly hall', placement: 'left', size: 'large' }] }
      },
      home: { highlights: [{ title: 'Small classes', text: 'Twenty at most.', image: pic }] }
    });
    expect(save.status).toBe(200);

    // the editor gets links it can show; the stored draft keeps references
    const editor = (await fx.oc.get('/website')).body.data;
    expect(editor.draft.media.home.background.image).toBe(hero);
    expect(editor.draftUrls.media.home.background.image).toMatch(/^\/api\/v1\/files\//);

    // nothing is public yet, but the preview already shows the draft with the pictures and the chosen settings
    const host = client(fx.host);
    expect((await host.get('/public/site')).status).toBe(404);
    const tok = (await fx.oc.post('/website/preview-token').send({})).body.data.token;
    const pre = (await host.get(`/public/site?preview=${encodeURIComponent(tok)}`)).body.data;
    expect(pre.content.media.home.background).toMatchObject({ position: 'top', overlay: 60, tone: 'brand' });
    expect(pre.content.media.home.background.image).toMatch(/^\/api\/v1\/files\//);
    expect(pre.content.media.about.pictures[0]).toMatchObject({ caption: 'Our assembly hall', placement: 'left', size: 'large' });
    expect(pre.content.media.about.backdrop).toMatchObject({ opacity: 30, blur: true });
    expect(pre.content.home.highlights[0].image).toMatch(/^\/api\/v1\/files\//);

    // settings are tidied: an out-of-range tint is clamped, an unknown placement falls back to the grid
    const odd = await fx.oc.patch('/website/draft').send({ media: { contact: { layout: 'custom', background: { image: hero, overlay: 80 }, pictures: [{ image: pic, placement: 'grid', size: 'small' }] } } });
    expect(odd.status).toBe(200);
    // removing a background clears it
    await fx.oc.patch('/website/draft').send({ media: { home: { background: null } } });
    expect((await fx.oc.get('/website')).body.data.draft.media.home.background).toBeNull();

    // publishing carries the pictures to the live site, with links visitors can open
    expect((await fx.oc.patch('/website/draft').send(ownText)).status).toBe(200);
    expect((await fx.oc.post('/website/publish').send({})).status).toBe(200);
    const live = (await host.get('/public/site')).body.data;
    expect(live.content.media.about.pictures[0].image).toMatch(/^\/api\/v1\/files\//);
    expect(live.content.media.about.backdrop.blur).toBe(true);

    // a reference to a file that is not in this school's folder is refused
    const other = await buildSchool();
    const foreign = await uploadPng(other.oc, 'site_image');
    const bad = await fx.oc.patch('/website/draft').send({ media: { home: { pictures: [{ image: foreign, placement: 'full', size: 'large' }] } } });
    expect(bad.status).toBe(422);
  });

  it('accepts every section of the draft sent back exactly as the editor reads it (the editor saves a whole section at a time)', async () => {
    const fx = await websiteReady();
    const first = (await fx.oc.get('/website')).body.data.draft;
    for (const section of ['home', 'about', 'academics', 'admissions', 'contact']) {
      const res = await fx.oc.patch('/website/draft').send({ [section]: first[section] });
      expect(res.status, `${section}: ${JSON.stringify(res.body.error?.fields)}`).toBe(200);
    }
    // the picture panels send their own parts
    const home = (await fx.oc.get('/website')).body.data.draft.home;
    const res = await fx.oc.patch('/website/draft').send({ home: { hero: { image: '' }, highlights: home.highlights.map((h: any) => ({ title: h.title, text: h.text, image: '' })) } });
    expect(res.status, JSON.stringify(res.body.error?.fields)).toBe(200);
  });

  it('carries testimonials, FAQs, the founding year and real facts (pupils, teachers, terms) to the public page', async () => {
    const fx = await websiteReady();
    const photo = await uploadPng(fx.oc, 'site_image');
    const save = await fx.oc.patch('/website/draft').send({
      about: { founded: '1998' },
      testimonials: [{ name: 'Mrs Bello', role: 'Parent of a Primary 3 pupil', quote: 'My daughter looks forward to school every morning.', photo }],
      faqs: [{ q: 'What time does school start?', a: 'Gates open at 7:30am.' }],
      home: { show: { stats: true } }
    });
    expect(save.status, JSON.stringify(save.body.error?.fields)).toBe(200);
    expect((await fx.oc.patch('/website/draft').send({ about: { founded: 'abcd' } })).body.data.draft.about.founded).toBe(''); // only a four digit year is kept

    const tok = (await fx.oc.post('/website/preview-token').send({})).body.data.token;
    const pre = (await client(fx.host).get(`/public/site?preview=${encodeURIComponent(tok)}`)).body.data;
    expect(pre.content.testimonials[0]).toMatchObject({ name: 'Mrs Bello' });
    expect(pre.content.testimonials[0].photo).toMatch(/^\/api\/v1\/files\//);
    expect(pre.content.faqs[0].q).toBe('What time does school start?');
    expect(pre.facts).toMatchObject({ pupils: expect.any(Number), teachers: expect.any(Number), classes: expect.any(Number) });
    expect(Array.isArray(pre.facts.terms)).toBe(true);
    expect(JSON.stringify(pre.facts)).not.toMatch(/firstName|lastName|phone/); // counts only, never people
  });

  it('does not let a pending school publish', async () => {
    const fx = await buildSchool({ status: 'pending' });
    await readyForWebsite(fx);
    await fx.oc.patch('/website/draft').send(ownText);
    const res = await fx.oc.post('/website/publish').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('school_not_active');
    expect((await fx.oc.get('/website/checks')).body.data.blocking[0].message).toMatch(/waiting for approval/);
  });

  it('hides sections that have no content, and shows news and gallery once there is something to show', async () => {
    const fx = await websiteReady();
    await fx.oc.patch('/website/draft').send(ownText);
    await fx.oc.post('/website/publish').send({});
    const host = client(fx.host);
    expect((await host.get('/public/site')).body.data.sections).toMatchObject({ news: false, gallery: false, staff: false });
    const img = await uploadPng(fx.oc);
    const post = await fx.oc.post('/website/posts').send({ title: 'Open day', body: '<p>Join us</p><script>alert(1)</script>', image: img, published: true });
    expect(post.status).toBe(201);
    expect(post.body.data.body).not.toContain('script');
    expect((await fx.oc.post('/website/gallery').send({ image: img, caption: 'Our hall' })).status).toBe(201);
    await fx.oc.post('/website/publish').send({});
    expect((await host.get('/public/site')).body.data.sections).toMatchObject({ news: true, gallery: true });
    const posts = await host.get('/public/site/posts');
    expect(posts.body.data[0].title).toBe('Open day');
    expect((await host.get(`/public/site/posts/${post.body.data.id}`)).body.data.body).toBe('<p>Join us</p>');
    expect((await host.get('/public/site/gallery')).body.data.length).toBe(1);
    // an unpublished post is invisible
    await fx.oc.patch(`/website/posts/${post.body.data.id}`).send({ published: false });
    expect((await host.get(`/public/site/posts/${post.body.data.id}`)).status).toBe(404);
  });

  it('refuses a 6 MB image and an SVG, and a file from another school', async () => {
    const fx = await websiteReady();
    const big = await fx.oc.post('/files/sign').send({ purpose: 'site_image', mime: 'image/png', size: 6 * 1024 * 1024 });
    expect(big.status).toBe(422);
    expect(big.body.error.message).toMatch(/limit is 5 MB/);
    const svg = await fx.oc.post('/files/sign').send({ purpose: 'site_image', mime: 'image/svg+xml' });
    expect(svg.status).toBe(422);
    const other = await buildSchool();
    const foreign = await uploadPng(other.oc);
    const res = await fx.oc.patch('/website/draft').send({ home: { hero: { image: foreign } } });
    expect(res.status).toBe(422);
    // the local upload address also enforces the size it signed
    const sign = await fx.oc.post('/files/sign').send({ purpose: 'student_photo', mime: 'image/png' });
    const huge = await client().agent.put(sign.body.data.uploadUrl).set('Content-Type', 'image/png').send(Buffer.alloc(3 * 1024 * 1024));
    expect(huge.status).toBe(422);
  });

  it('shows two schools with different colours the same layout in their own brand, and gives a yellow primary dark button text', async () => {
    const a = await websiteReady();
    const b = await buildSchool();
    await readyForWebsite(b);
    await b.oc.patch('/school/branding').send({ primary: '#facc15', secondary: '#1e3a8a' });
    for (const fx of [a, b]) {
      await fx.oc.patch('/website/draft').send(ownText);
      expect((await fx.oc.post('/website/publish').send({})).status).toBe(200);
    }
    const sa = (await client(a.host).get('/public/site')).body.data;
    const sb = (await client(b.host).get('/public/site')).body.data;
    expect(sa.brand.tokens.primaryContrast).toBe('#ffffff');
    expect(sb.brand.tokens.primary).toBe('#facc15');
    expect(sb.brand.tokens.primaryContrast).toBe('#000000');
    expect(Object.keys(sa.content)).toEqual(Object.keys(sb.content)); // same layout, same shape
    expect(sa.brand.tokens.primary).not.toBe(sb.brand.tokens.primary);
    // colours too close together are warned about
    const warn = await b.oc.patch('/school/branding').send({ primary: '#1d4ed8', secondary: '#1e50d8' });
    expect(warn.body.data.warnings.join(' ')).toMatch(/too close/);
  });

  it('takes enquiries into an inbox, notifies the school admin, ignores bots, and rate limits', async () => {
    const fx = await websiteReady();
    await fx.oc.patch('/website/draft').send(ownText);
    await fx.oc.post('/website/publish').send({});
    const admin = await makeStaff(fx.school, ['school_admin']);
    const { c: ac } = await signIn(admin.phone, fx.host);
    const visitor = client(fx.host);
    const res = await visitor.post('/public/site/enquiries').send({ name: 'Ife', phone: '08031230000', message: 'Do you have space in Primary 2?' });
    expect(res.status).toBe(201);
    expect((await visitor.post('/public/site/enquiries').send({ name: 'Bot', phone: '08031230000', message: 'buy now', website: 'http://spam' })).body.data).toEqual({ received: true }); // honeypot
    expect((await visitor.post('/public/site/enquiries').send({ name: 'Nobody', message: 'Hello there' })).status).toBe(422);
    await drainJobs();
    const inbox = (await ac.get('/enquiries')).body.data;
    expect(inbox.length).toBe(1);
    expect(inbox[0]).toMatchObject({ name: 'Ife', status: 'new' });
    expect(await ctxFor(String(fx.school._id), () => Notification.countDocuments({ userId: admin.user._id, type: 'enquiry_received' }))).toBe(1);
    expect((await ac.patch(`/enquiries/${inbox[0].id}`).send({ status: 'handled' })).body.data.status).toBe('handled');
    // teachers cannot read the inbox
    const t = await makeStaff(fx.school, ['subject_teacher']);
    expect((await (await signIn(t.phone, fx.host)).c.get('/enquiries')).status).toBe(403);
  });

  it('shows the neutral 503 page for a taken-down site until the platform restores it; the school cannot republish meanwhile', async () => {
    const fx = await websiteReady();
    await fx.oc.patch('/website/draft').send(ownText);
    await fx.oc.post('/website/publish').send({});
    const { c: sa } = await signInSuperAdmin();
    expect((await sa.post(`/platform/sites/${fx.school._id}/takedown`).send({})).status).toBe(422); // a reason is needed
    expect((await sa.post(`/platform/sites/${fx.school._id}/takedown`).send({ reason: 'Breaks content rules' })).status).toBe(200);
    const host = client(fx.host);
    const down = await host.get('/public/site');
    expect(down.status).toBe(503);
    expect(down.body.data.neutral).toBe(true);
    expect(down.headers['x-robots-tag']).toBe('noindex');
    const blocked = await fx.oc.post('/website/publish').send({});
    expect(blocked.status).toBe(409);
    expect((await fx.oc.get('/website')).body.data.takedown.reason).toBe('Breaks content rules');
    expect((await sa.post(`/platform/sites/${fx.school._id}/restore`).send({})).status).toBe(200);
    expect((await fx.oc.post('/website/publish').send({})).status).toBe(200);
    expect((await host.get('/public/site')).status).toBe(200);
    expect((await sa.get('/platform/sites/feed')).body.data[0].slug).toBe(fx.school.slug);
  });

  it('shows the neutral page while the school is suspended', async () => {
    const fx = await websiteReady();
    await fx.oc.patch('/website/draft').send(ownText);
    await fx.oc.post('/website/publish').send({});
    const { c: sa } = await signInSuperAdmin();
    await sa.post(`/platform/schools/${fx.school._id}/suspend`).send({ reason: 'Unpaid' });
    expect((await client(fx.host).get('/public/site')).status).toBe(503);
  });

  it('releases a template version to every site at once, and rolls back', async () => {
    const fx = await websiteReady();
    await fx.oc.patch('/website/draft').send(ownText);
    await fx.oc.post('/website/publish').send({});
    const { c: sa } = await signInSuperAdmin();
    expect((await sa.get('/platform/template-versions')).body.data.map((v: any) => v.version)).toEqual([1]);
    expect((await sa.post('/platform/template-versions').send({ version: 2, notes: 'New header' })).status).toBe(201);
    expect((await sa.post('/platform/template-versions/2/release').send({})).status).toBe(200);
    const versions = (await sa.get('/platform/template-versions')).body.data;
    expect(versions.find((v: any) => v.isCurrent).version).toBe(2);
    // the version is read at render time, so republishing moves the site, and rollback restores the earlier one
    await fx.oc.post('/website/publish').send({});
    expect((await client(fx.host).get('/public/site')).body.data.templateVersion).toBe(2);
    expect((await sa.post('/platform/template-versions/1/release').send({})).status).toBe(200);
    expect((await platform(() => TemplateVersion.findOne({ isCurrent: true }).lean())).version).toBe(1);
    expect((await sa.post('/platform/template-versions/9/release').send({})).status).toBe(404);
  });

  it('gives each school its own sitemap, only for a published site', async () => {
    const fx = await websiteReady();
    expect((await client(fx.host).get('/public/site/sitemap')).status).toBe(404);
    await fx.oc.patch('/website/draft').send(ownText);
    await fx.oc.post('/website/publish').send({});
    const sm = (await client(fx.host).get('/public/site/sitemap')).body.data;
    expect(sm.map((e: any) => e.url).some((u: string) => u.includes(fx.school.slug))).toBe(true);
    expect(sm.length).toBeGreaterThanOrEqual(7);
  });

  it('cleans pasted markup in the editor and refuses unknown fields', async () => {
    const fx = await websiteReady();
    const res = await fx.oc.patch('/website/draft').send({ about: { history: '<img src=x onerror=alert(1)><b>Bold</b> and <a href="javascript:alert(1)">link</a>' }, contact: { social: { facebook: 'javascript:alert(1)' } } });
    expect(res.status).toBe(200);
    expect(res.body.data.draft.about.history).toBe('<b>Bold</b> and <a>link</a>'.replace('<a>', '<a rel="noopener noreferrer" target="_blank">'));
    expect(res.body.data.draft.contact.social.facebook).toBe('');
    expect((await fx.oc.patch('/website/draft').send({ evil: { a: 1 } })).status).toBe(422);
    expect((await fx.oc.patch('/website/draft').send({ home: { hero: { headline: 'x'.repeat(200) } } })).status).toBe(422);
    void Site;
  });
});
