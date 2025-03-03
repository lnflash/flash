import { redisCache } from "@services/redis"
import { ICache, CacheSetArgs } from "ibex-client/dist/storage"

// Map Ibex Cache interface to RedisCacheService defined in this repo
export const Redis = {
  get: (key: string) => redisCache.getCache(key),
  set: async <T>(args: CacheSetArgs<NonError<T>>) => {
    const res = await redisCache.setCache(
      args.key,
      args.value,
      args.ttlSecs as Seconds,
    )
    return res === "OK" 
  },
} as ICache