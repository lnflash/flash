import { redisCache } from "@services/redis"
import { ICache, CacheSetArgs } from "ibex-client/dist/storage"

// Map Redis Interface to interface used in ibex-client 
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
  delete: (key: string) => {
    redisCache.deleteCache(key)
    return
  },
} as ICache