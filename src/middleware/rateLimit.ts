import type { Context, Next } from "hono";
import type { AppEnv } from "../lib/hono.js";
import { redis } from "../lib/redis.js";

// ─── Sliding window via Redis sorted sets ─────────────────────────────────────

function getIp(c: Context<AppEnv>): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

async function slidingWindowCount(key: string, windowSec: number): Promise<number> {
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  const member = `${now}:${Math.random().toString(36).slice(2)}`;

  const pipe = redis.pipeline();
  pipe.zremrangebyscore(key, 0, windowStart);         // remove expired
  pipe.zadd(key, now, member);                         // record this request
  pipe.zcard(key);                                     // count in window
  pipe.pexpire(key, windowSec * 1000 + 5000);         // auto-expire key

  const results = await pipe.exec();
  return (results?.[2]?.[1] as number) ?? 1;
}

// ─── Generic rate limit factory ───────────────────────────────────────────────

interface RateLimitOptions {
  key: (c: Context<AppEnv>) => string;
  max: number;
  windowSec: number;
}

export function rateLimit({ key, max, windowSec }: RateLimitOptions) {
  return async (c: Context<AppEnv>, next: Next) => {
    let count: number;
    try {
      count = await slidingWindowCount(key(c), windowSec);
    } catch {
      // Redis unavailable — fail open so auth still works
      await next();
      return;
    }

    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + windowSec));

    if (count > max) {
      c.header("Retry-After", String(windowSec));
      return c.json(
        { error: "too_many_requests", retryAfter: windowSec },
        429
      );
    }

    await next();
  };
}

// ─── Pre-built limiters ───────────────────────────────────────────────────────

/** /auth/check — 20 per minute per IP (email existence probe) */
export const authCheckLimit = rateLimit({
  key: (c) => `rl:auth:check:${getIp(c)}`,
  max: 20,
  windowSec: 60,
});

/** /auth/password/login — 20 per 15 min per IP */
export const loginRateLimit = rateLimit({
  key: (c) => `rl:login:${getIp(c)}`,
  max: 20,
  windowSec: 900,
});

/** /auth/register — 5 per 15 min per IP */
export const registerLimit = rateLimit({
  key: (c) => `rl:register:${getIp(c)}`,
  max: 5,
  windowSec: 900,
});

/** /auth/email/verify — 10 per 15 min per IP */
export const emailVerifyLimit = rateLimit({
  key: (c) => `rl:email:verify:${getIp(c)}`,
  max: 10,
  windowSec: 900,
});

/** /auth/password/reset/request — 5 per hour per IP */
export const passwordResetRequestLimit = rateLimit({
  key: (c) => `rl:pw:reset:req:${getIp(c)}`,
  max: 5,
  windowSec: 3600,
});

/** /auth/password/reset/confirm — 10 per 15 min per IP */
export const passwordResetConfirmLimit = rateLimit({
  key: (c) => `rl:pw:reset:confirm:${getIp(c)}`,
  max: 10,
  windowSec: 900,
});

/** /auth/token/refresh — 60 per 15 min per IP (generous, needed for SPA) */
export const tokenRefreshLimit = rateLimit({
  key: (c) => `rl:refresh:${getIp(c)}`,
  max: 60,
  windowSec: 900,
});

/** OAuth exchange — 20 per minute per IP */
export const oauthExchangeLimit = rateLimit({
  key: (c) => `rl:oauth:exchange:${getIp(c)}`,
  max: 20,
  windowSec: 60,
});

/** MFA challenge/verify — 10 per 15 min per IP */
export const mfaChallengeLimit = rateLimit({
  key: (c) => `rl:mfa:challenge:${getIp(c)}`,
  max: 10,
  windowSec: 900,
});

/** Recovery codes — 5 per hour per IP (high-value endpoint) */
export const recoveryCodeLimit = rateLimit({
  key: (c) => `rl:mfa:recovery:${getIp(c)}`,
  max: 5,
  windowSec: 3600,
});

/** Passkey authenticate — 20 per 15 min per IP */
export const passkeyAuthLimit = rateLimit({
  key: (c) => `rl:passkey:auth:${getIp(c)}`,
  max: 20,
  windowSec: 900,
});

/** Global baseline — 200 per minute per IP (circuit-breaker) */
export const globalLimit = rateLimit({
  key: (c) => `rl:global:${getIp(c)}`,
  max: 200,
  windowSec: 60,
});
