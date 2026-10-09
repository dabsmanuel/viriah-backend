import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 240000,
    fileParallelism: false,
    // service keys are blank on purpose: tests use the built-in fake SMS, email, storage and Paystack
    env: { APP_ENV: 'test', PAYSTACK_SECRET_KEY: '', PAYSTACK_PUBLIC_KEY: '', TERMII_API_KEY: '', EMAIL_API_KEY: '', CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', SENTRY_DSN: '' }
  }
});
