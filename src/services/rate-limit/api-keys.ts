import { baseLogger } from "@services/logger"
import { redis } from "@services/redis"
import { RateLimiterRedis } from "rate-limiter-flexible"

// Per-API-key request rate limiting (ENG-100/101). Standalone from the
// RateLimitConfig map: those limiters are per-declaration with fixed points
// and a blockDuration; this one is per-key with a caller-supplied limit and
// a plain sliding window (no block on top of the window itself).
export const API_KEY_REQUEST_LIMIT_PREFIX = "api_key_request"

const DURATION_SECONDS = 60

export type ApiKeyRateLimitResult =
  | {
      allowed: true
      limit: number
      remaining: number
      resetSeconds: number
    }
  | {
      allowed: false
      limit: number
      remaining: 0
      retryAfterSeconds: number
      resetSeconds: number
    }

// RateLimiterRedis instances are limit-shaped, not key-shaped: one instance
// per distinct limit serves every key at that limit (the consumed key is the
// keyId). Distinct limits are bounded by distinct per-key configs, so the
// map stays tiny.
const limiters = new Map<number, RateLimiterRedis>()

const limiterFor = (limitPerMinute: number): RateLimiterRedis => {
  let limiter = limiters.get(limitPerMinute)
  if (!limiter) {
    limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: API_KEY_REQUEST_LIMIT_PREFIX,
      points: limitPerMinute,
      duration: DURATION_SECONDS,
    })
    limiters.set(limitPerMinute, limiter)
  }
  return limiter
}

// Never throws. On limit exceed it returns the denied shape with the header
// material (retry/reset); on redis failure it FAILS OPEN — rate limiting
// must never take the API down.
export const consumeApiKeyRequestRateLimit = async ({
  keyId,
  limitPerMinute,
}: {
  keyId: string
  limitPerMinute: number
}): Promise<ApiKeyRateLimitResult> => {
  try {
    const res = await limiterFor(limitPerMinute).consume(keyId, 1)
    return {
      allowed: true,
      limit: limitPerMinute,
      remaining: res.remainingPoints,
      resetSeconds: Math.ceil(res.msBeforeNext / 1000),
    }
  } catch (err) {
    // rate-limiter-flexible rejects with a RateLimiterRes (not an Error) when
    // the limit is exceeded, and with an Error when the store (redis) fails.
    if (err instanceof Error) {
      baseLogger.warn(
        { err, keyId },
        "api key rate limiter store unavailable - failing open",
      )
      return {
        allowed: true,
        limit: limitPerMinute,
        remaining: limitPerMinute,
        resetSeconds: DURATION_SECONDS,
      }
    }

    const rejection = err as { msBeforeNext?: number }
    const msBeforeNext = rejection?.msBeforeNext ?? DURATION_SECONDS * 1000
    const retryAfterSeconds = Math.max(1, Math.ceil(msBeforeNext / 1000))
    return {
      allowed: false,
      limit: limitPerMinute,
      remaining: 0,
      retryAfterSeconds,
      resetSeconds: retryAfterSeconds,
    }
  }
}
