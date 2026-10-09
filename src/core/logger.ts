import pino from 'pino';
import { env, isTest } from '../config/env';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: { app: 'viriah-api', env: env.APP_ENV },
  // Personal data and tokens are never logged.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.code',
      '*.phone',
      '*.email'
    ],
    censor: '[redacted]'
  }
});
