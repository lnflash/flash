import { RedisCacheService } from "@services/cache"
import { ICache, CacheSetArgs as IbexCacheArgs } from "ibex-client/dist/storage"

// Map Ibex Cache interface to RedisCacheService defined in this repo
export const Redis = {
  get: <T>(key: string) => RedisCacheService().get<T>({ key }),
  set: <T>(args: IbexCacheArgs<NonError<T>>) => RedisCacheService().set({
    key: args.key,
    value: args.value,
    ttlSecs: args.ttlSecs as Seconds,
  })
} as ICache