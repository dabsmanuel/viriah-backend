import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { env, isLocal } from './config/env';
import { emptyCtx, runWithCtx } from './core/context';
import { errorHandler, notFoundHandler } from './core/errorHandler';
import { logger } from './core/logger';
import { AppError } from './core/errors';
import { stripOperators } from './core/sanitize';
import { API_PREFIX } from './core/route';
import { registerAllModules } from './modules';

/**
 * One Express application serves every school. The web application forwards /api requests on each host to this
 * service and passes the original host (Document 3, section 4). Browsers do not call it directly.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', isLocal ? false : 1);

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: { maxAge: 63072000, includeSubDomains: true }
    })
  );

  // Body parsers run before the request context starts: AsyncLocalStorage can lose context inside stream callbacks.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        // Webhook signatures are checked on the raw body.
        if ((req as Request).url.includes('/webhooks/')) (req as any).rawBody = buf;
      }
    })
  );
  app.use(cookieParser());

  // Request context, request ID and access log.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.header('x-request-id') ?? `req_${crypto.randomBytes(8).toString('hex')}`).slice(0, 64);
    res.setHeader('X-Request-Id', requestId);
    const ctx = { ...emptyCtx(), requestId, ip: req.ip, userAgent: req.header('user-agent') };
    const started = Date.now();
    res.on('finish', () => {
      logger.info({ requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, userId: ctx.userId, schoolId: ctx.schoolId, ...(res.locals.errorFields ? { fields: res.locals.errorFields } : {}) }, 'request');
    });
    runWithCtx(ctx, () => next());
  });

  // Operators in user input are stripped before anything can use them in a query.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = stripOperators(req.body);
    const q = stripOperators({ ...req.query });
    Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true });
    next();
  });

  // Cross-site request protection: SameSite cookies plus a required custom header on every state-changing request.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const changes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const exempt = req.path.startsWith(`${API_PREFIX}/webhooks/`) || req.path.startsWith(`${API_PREFIX}/files/local-upload/`);
    if (changes && !exempt && req.header('x-requested-with') !== 'fetch') {
      return next(new AppError('forbidden', 'This request is missing the X-Requested-With: fetch header.'));
    }
    next();
  });

  registerAllModules(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const platformInfo = () => ({ name: 'viriah-api', env: env.APP_ENV });
