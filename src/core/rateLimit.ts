import type { Request, RequestHandler } from 'express';
import { isTest } from '../config/env';
import { AppError } from './errors';
import { redisClient } from '../jobs/queue';

/**
 * Rate limits on login, code requests, password reset, the application form, the enquiry form and the verify page.
 * Redis when REDIS_URL is set (shared across API instances), memory otherwise.
 */

interface Store {
  hit(key: string, windowMs: number): Promise<{ count: number; retryAfterSec: number }>;
}

class MemoryStore implements Store {
  private hits = new Map<string, { count: number; resetAt: number }>();
  async hit(key: string, windowMs: number) {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      this.hits.set(key, h);
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    h.count += 1;
    return { count: h.count, retryAfterSec: Math.ceil((h.resetAt - now) / 1000) };
  }
  reset() {
    this.hits.clear();
  }
}

class RedisStore implements Store {
  async hit(key: string, windowMs: number) {
    const r = redisClient()!;
    const k = `rl:${key}`;
    const count = await r.incr(k);
    if (count === 1) await r.pexpire(k, windowMs);
    const ttl = await r.pttl(k);
    return { count, retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)) };
  }
}

const memory = new MemoryStore();
const store = (): Store => (redisClient() ? new RedisStore() : memory);

export const limiter = { enabled: !isTest };
export const resetLimits = () => memory.reset();

export async function consume(key: string, windowMs: number, max: number) {
  if (!limiter.enabled) return;
  const { count, retryAfterSec } = await store().hit(key, windowMs);
  if (count > max) throw new AppError('rate_limited', 'Too many attempts. Wait a little and try again.', { retryAfter: retryAfterSec });
}

export const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export function rateLimit(name: string, windowMs: number, max: number, by: (req: Request) => string = clientIp): RequestHandler {
  return (req, _res, next) => {
    consume(`${name}:${by(req)}`, windowMs, max).then(() => next(), next);
  };
}
