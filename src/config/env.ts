import dotenv from 'dotenv';
import { z } from 'zod';

// Tests never read .env: a developer's real keys must not turn a test run into real texts, charges or uploads.
if (process.env.APP_ENV !== 'test') dotenv.config();

const schema = z.object({
  APP_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),
  PORT: z.coerce.number().default(4000),
  PLATFORM_DOMAIN: z.string().default('yourplatform.ng'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.string().default('info'),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/viriah?replicaSet=rs0'),
  REDIS_URL: z.string().optional().default(''),

  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me-please-0001'),
  JWT_SUPPORT_SECRET: z.string().min(16).default('dev-support-secret-change-me-please-001'),
  COOKIE_SECRET: z.string().min(16).default('dev-cookie-secret-change-me-please-0001'),
  REVALIDATE_SECRET: z.string().default('dev-revalidate-secret'),

  PAYSTACK_SECRET_KEY: z.string().optional().default(''),
  PAYSTACK_PUBLIC_KEY: z.string().optional().default(''),

  TERMII_API_KEY: z.string().optional().default(''),
  TERMII_SENDER_ID: z.string().optional().default(''),

  EMAIL_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('no-reply@yourplatform.ng'),

  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),

  SENTRY_DSN: z.string().optional().default(''),

  SUPER_ADMIN_PHONE: z.string().default('+2349000000001'),
  SUPER_ADMIN_EMAIL: z.string().default('admin@yourplatform.ng'),
  SUPER_ADMIN_PASSWORD: z.string().default('ChangeMe!12345'),

  SMS_ALLOW_LIST: z.string().optional().default('')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
   
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.APP_ENV === 'production';
export const isTest = env.APP_ENV === 'test';
export const isLocal = env.APP_ENV === 'local' || env.APP_ENV === 'test';

if (isProd) {
  const weak = [env.JWT_ACCESS_SECRET, env.JWT_SUPPORT_SECRET, env.COOKIE_SECRET].some((s) => s.startsWith('dev-'));
  if (weak) {
     
    console.error('Refusing to start in production with development secrets.');
    process.exit(1);
  }
}
