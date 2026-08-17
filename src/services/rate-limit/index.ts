import {
  RateLimiterExceededError,
  UnknownRateLimitServiceError,
} from "@domain/rate-limit/errors"
import { redis } from "@services/redis"
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible"

export const RedisRateLimitService = ({
  keyPrefix,
  limitOptions,
}: {
  keyPrefix: RateLimitPrefix
  limitOptions: RateLimitOptions
}): IRateLimitService => {
  const limiter = new RateLimiterRedis({ storeClient: redis, keyPrefix, ...limitOptions })

  const consume = async (key: string) => {
    try {
      await limiter.consume(key)
      return true
    } catch (err) {
      // `limiter.consume` rejects for two unrelated reasons, and they must not
      // be conflated. A RateLimiterRes rejection means the caller really is
      // over the limit. Anything else is the STORE failing — with no
      // insuranceLimiter configured, a Redis outage rejects with the raw store
      // error — and reporting that as "too many attempts" tells every user
      // they are rate limited on their first request of the day, while hiding
      // the outage from whoever is on call.
      if (err instanceof RateLimiterRes) return new RateLimiterExceededError()
      return new UnknownRateLimitServiceError(err)
    }
  }

  const reset = async (key: string) => {
    try {
      await limiter.delete(key)
      return true
    } catch (err) {
      return new UnknownRateLimitServiceError(err)
    }
  }

  const reward = async (key: string) => {
    try {
      await limiter.reward(key)
      return true
    } catch (err) {
      return new UnknownRateLimitServiceError(err)
    }
  }

  return { consume, reset, reward }
}

export const consumeLimiter = async ({
  rateLimitConfig,
  keyToConsume,
}: {
  rateLimitConfig: RateLimitConfig
  keyToConsume: IpAddress | LoginIdentifier | AccountId | ""
}) => {
  const limiter = RedisRateLimitService({
    keyPrefix: rateLimitConfig.key,
    limitOptions: rateLimitConfig.limits,
  })
  const consume = await limiter.consume(keyToConsume)
  // Only a genuine limit breach becomes the caller's "too many attempts"
  // error; a store fault propagates as itself so it can be told apart.
  if (consume instanceof RateLimiterExceededError) return new rateLimitConfig.error()
  return consume
}

export const resetLimiter = async ({
  rateLimitConfig,
  keyToConsume,
}: {
  rateLimitConfig: RateLimitConfig
  keyToConsume: IpAddress | LoginIdentifier | AccountId
}) => {
  const limiter = RedisRateLimitService({
    keyPrefix: rateLimitConfig.key,
    limitOptions: rateLimitConfig.limits,
  })
  return limiter.reset(keyToConsume)
}
