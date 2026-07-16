import {
  CacheNotAvailableError,
  CacheUndefinedError,
  UnknownCacheServiceError,
} from "@domain/cache"
import { redisCache } from "@services/redis"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"

export const RedisCacheService = (): ICacheService => {
  const set = async <T>({
    key,
    value,
    ttlSecs,
  }: LocalCacheSetArgs<T>): Promise<T | CacheServiceError> => {
    try {
      const res = await redisCache.setCache(key, value, ttlSecs)
      if (res !== "OK") return new CacheNotAvailableError()

      return value
    } catch (err) {
      return new UnknownCacheServiceError(err)
    }
  }

  const get = async <T>({ key }: LocalCacheGetArgs): Promise<T | CacheServiceError> => {
    try {
      const value = await redisCache.getCache(key)
      if (value === undefined) return new CacheUndefinedError()

      return value as T
    } catch (err) {
      return new UnknownCacheServiceError(err)
    }
  }

  const getOrSet = async <C, F extends () => ReturnType<F>>({
    key,
    ttlSecs,
    getForCaching,
    inflate,
  }: LocalCacheGetOrSetArgs<C, F>): Promise<ReturnType<F>> => {
    if (inflate) {
      const cachedData = await get<C>({ key })
      if (!(cachedData instanceof Error)) return inflate(cachedData)
    } else {
      const cachedData = await get<ReturnType<F>>({ key })
      if (!(cachedData instanceof Error)) return cachedData
    }

    const data = await getForCaching()

    // Typescript can't parse 'ReturnType<F>' to filter out 'Error' types
    if (data instanceof Error) return data
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    set<ReturnType<F>>({ key, value: data, ttlSecs })
    return data
  }

  const clear = async ({
    key,
  }: LocalCacheClearArgs): Promise<true | CacheServiceError> => {
    try {
      await redisCache.deleteCache(key)
      return true
    } catch (err) {
      return new UnknownCacheServiceError(err)
    }
  }

  return wrapAsyncFunctionsToRunInSpan({
    namespace: "services.cache.redis",
    fns: { set, get, getOrSet, clear },
  })
}

/**
 * Atomically deletes `key`, returning `true` only for the caller whose DEL
 * actually removed it. Redis executes each DEL serially, so among concurrent
 * callers exactly one sees a removed-count of 1 — the basis for one-time-use
 * keys (e.g. Plaid link tokens). `false` means the key was already gone: lost
 * the race, expired, or never existed.
 *
 * `clear` cannot express this: it discards the removed-count and always
 * resolves `true`, so get-then-`clear` is a TOCTOU race in which concurrent
 * consumers all "succeed". Gate single-use on this function instead.
 */
export const consumeCacheKey = async ({
  key,
}: LocalCacheClearArgs): Promise<boolean | CacheServiceError> => {
  try {
    const removed = await redisCache.deleteCache(key)
    return removed === 1
  } catch (err) {
    return new UnknownCacheServiceError(err)
  }
}
