import type { Context, Next } from "hono";
import { getRedis } from "../lib/redis";
import { logWarn } from "../lib/debug";
import { env } from "../env";

interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  max: number; // Max requests per window
  keyPrefix?: string;
}

// In-memory fallback rate limiter for when Redis is unavailable
const memoryStore = new Map<string, { count: number; resetAt: number }>();

function cleanupMemoryStore() {
  const now = Date.now();
  for (const [key, value] of memoryStore) {
    if (value.resetAt < now) {
      memoryStore.delete(key);
    }
  }
}

// Clean up stale entries every minute
setInterval(cleanupMemoryStore, 60 * 1000);

function checkMemoryRateLimit(
  key: string,
  windowMs: number,
  max: number,
): { current: number; allowed: boolean } {
  const now = Date.now();
  const entry = memoryStore.get(key);

  if (!entry || entry.resetAt < now) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return { current: 1, allowed: true };
  }

  entry.count++;
  return { current: entry.count, allowed: entry.count <= max };
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyPrefix = "rl" } = options;

  return async (c: Context, next: Next) => {
    const redis = getRedis();

    // Use IP + path as key
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0] ||
      c.req.header("x-real-ip") ||
      "unknown";
    const key = `${keyPrefix}:${ip}:${c.req.path}`;
    const windowSec = Math.ceil(windowMs / 1000);

    // Fallback to in-memory rate limiting if Redis not available
    if (!redis) {
      logWarn("RateLimit", "Redis not available, using in-memory fallback");
      const { current, allowed } = checkMemoryRateLimit(key, windowMs, max);

      c.header("X-RateLimit-Limit", String(max));
      c.header("X-RateLimit-Remaining", String(Math.max(0, max - current)));

      if (!allowed) {
        return c.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests, please try again later",
              retryAfter: windowSec,
            },
          },
          429,
        );
      }

      return next();
    }

    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }

    // Set rate limit headers
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - current)));

    if (current > max) {
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests, please try again later",
            retryAfter: windowSec,
          },
        },
        429,
      );
    }

    return next();
  };
}

// Pre-configured rate limiters
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.DEV_MODE ? 100 : 10,
  keyPrefix: "auth",
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  keyPrefix: "api",
});

// Stricter rate limit for expensive AI generation operations
export const aiGenerateRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 AI generations per minute
  keyPrefix: "ai-gen",
});

// Rate limit for public endpoints (subscribe/unsubscribe)
export const publicRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute per IP
  keyPrefix: "public",
});
