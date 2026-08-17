/**
 * In-memory rate limiting.
 *
 * The moment this server is reachable from the internet, `/v1/auth/login`
 * becomes a password oracle anyone can hammer. scrypt makes each guess
 * expensive for the attacker, but it makes it expensive for *us* too — a few
 * hundred concurrent guesses is a denial of service on a free instance long
 * before it is a successful break-in. The cheapest fix is to stop counting.
 *
 * ## Why in-memory rather than Redis
 *
 * A counter in a Map is wrong across multiple instances: each one enforces its
 * own limit, so N instances means N times the allowance. That is a real
 * weakness and worth naming — but this deployment is a single free instance, and
 * a limiter that exists is worth far more than a correct one that is waiting on
 * infrastructure nobody has provisioned. Move to Redis when there is a second
 * instance, not before.
 *
 * State is lost on restart, which on a free tier that sleeps means the window
 * resets more often than it should. That favours the user over the attacker,
 * which is the right direction for the error to lean.
 */

import type { MiddlewareHandler } from 'hono';

import { env } from '@/env';
import { ApiError } from '@/lib/errors';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * Sweeps expired entries.
 *
 * Without it the Map grows one entry per distinct IP forever, which on a
 * long-running process is a slow memory leak rather than a limiter.
 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Node keeps the process alive for pending timers; this one must not.
}, SWEEP_INTERVAL_MS).unref();

/**
 * Best guess at who is calling.
 *
 * Behind Render's proxy the socket address is the proxy, so `x-forwarded-for`
 * is the only useful signal. It is also trivially forgeable by a direct caller —
 * which is acceptable here because the limiter is a brake on casual abuse, not
 * an access control. Anything that must not be bypassed lives in the auth code.
 */
function clientKey(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();

  const direct = headers.get('cf-connecting-ip') ?? headers.get('x-real-ip');
  if (direct) return direct;

  /*
   * No proxy header at all means nothing sits in front of us — a developer
   * calling their own machine. Outside production that is exempted, because a
   * limiter whose first victim is the test suite gets raised until it protects
   * nobody. In production every request arrives through Render's proxy and
   * therefore always carries `x-forwarded-for`, so this branch is unreachable
   * there; a request that somehow lacks it is still counted, under `unknown`.
   */
  return env.NODE_ENV === 'production' ? 'unknown' : null;
}

export type RateLimitOptions = {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** Distinguishes buckets so auth and AI limits do not share a counter. */
  name: string;
};

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const client = clientKey(c.req.raw.headers);
    if (client === null) return next();

    const key = `${options.name}:${client}`;
    const now = Date.now();

    const existing = buckets.get(key);
    const bucket =
      existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    buckets.set(key, bucket);

    const remaining = Math.max(0, options.limit - bucket.count);
    c.header('X-RateLimit-Limit', String(options.limit));
    c.header('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > options.limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      throw new ApiError(
        'rate_limited',
        429,
        `Quá nhiều yêu cầu. Thử lại sau ${retryAfter} giây.`,
      );
    }

    await next();
  };
}

/**
 * Credential endpoints.
 *
 * Ten attempts per fifteen minutes per address. Loose enough that a person
 * mistyping a password never notices, tight enough that a dictionary attack is
 * pointless.
 */
export const authRateLimit = rateLimit({ name: 'auth', limit: 10, windowMs: 15 * 60 * 1000 });

/**
 * The AI endpoint, which costs real money per call.
 *
 * Thirty an hour is far above what a person recording their own spending
 * produces, and far below what an abandoned key would cost overnight.
 */
export const aiRateLimit = rateLimit({ name: 'ai', limit: 30, windowMs: 60 * 60 * 1000 });

/** Sync is a device talking to itself; generous, but not unbounded. */
export const syncRateLimit = rateLimit({ name: 'sync', limit: 120, windowMs: 60 * 1000 });
