import { createRoutes } from '../core/route';
import { z, code6, email, name, password, phone, slugSchema, text } from '../core/validate';
import { created, ok } from '../core/http';
import * as schools from '../services/schools';
import { platformSettings } from '../services/common';

const r = createRoutes('/public');
export const router = r.router;

const signupRate = { name: 'signup', windowMs: 60 * 60_000, max: 30 };

r.get('/schools/check-slug', { access: 'public', rate: { name: 'slug', windowMs: 60_000, max: 120 }, query: z.object({ slug: z.string().max(60), town: text(80).optional() }).strict(), summary: 'Is this web address free? Returns suggestions if not' }, async (req) => {
  const q = req.query as { slug: string; town?: string };
  return ok(await schools.checkSlug(q.slug, { town: q.town }));
});

r.post('/schools/register/start', { access: 'public', rate: signupRate, body: z.object({ phone, email }).strict(), summary: 'Send an SMS code to the owner’s phone and a link to the email' }, async (req) => {
  await schools.registerStart(req.body, req);
  return ok({ message: 'We sent a code by SMS and a link by email.' });
});

r.post('/schools/register/verify', { access: 'public', rate: signupRate, body: z.object({ phone, email, code: code6, emailToken: z.string().min(10).max(200) }).strict(), summary: 'Confirm the code and the email link. Returns a short-lived sign-up token' }, async (req) => ok(await schools.registerVerify(req.body)));

r.post(
  '/schools/register',
  {
    access: 'public',
    rate: signupRate,
    body: z.object({
      signupToken: z.string().min(20).max(2000),
      slug: slugSchema,
      school: z.object({
        name: name(120),
        types: z.array(z.enum(['nursery', 'primary', 'secondary'])).min(1, 'Choose at least one type.'),
        address: z.object({ street: text(200).optional(), town: text(80).optional(), lga: name(80), state: name(60) }).strict(),
        registrationNumber: text(60).optional(),
        phone: phone.optional(),
        email: email.optional()
      }).strict(),
      owner: z.object({ firstName: name(), lastName: name(), password }).strict(),
      acceptTerms: z.literal(true, { message: 'Accept the terms of use.' }),
      acceptDpa: z.literal(true, { message: 'Accept the data processing agreement.' })
    }).strict(),
    summary: 'Submit the school sign-up. Creates the school as pending and the owner’s account'
  },
  async (req) => created(await schools.registerSchool(req.body))
);

r.get('/schools/search', { access: 'public', rate: { name: 'school-search', windowMs: 60_000, max: 60 }, query: z.object({ q: z.string().trim().min(2).max(80) }).strict(), summary: 'Find a school by name' }, async (req) => ok(await schools.searchSchools((req.query as { q: string }).q)));

r.get('/legal', { access: 'public', summary: 'Terms, privacy notice and agreements (platform)' }, async () => {
  const s = await platformSettings();
  return ok(s.legalTexts ?? {});
});
