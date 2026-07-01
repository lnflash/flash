import { randomUUID } from "crypto"

import { CacheServiceError, CacheUndefinedError, OfferNotFound } from "@domain/cache"
import { RedisCacheService } from "@services/cache"

import ValidOffer from "../ValidOffer"

import { parseRepositoryError } from "../../../services/mongoose/utils"

import { OffersSerde } from "./OffersSerde"
import PersistedOffer from "./PersistedOffer"

const Redis = {
  add: async (o: ValidOffer): Promise<PersistedOffer | CacheServiceError> => {
    const id = randomUUID() as OfferId // could use hash of offer details with getOrSet
    const result = await RedisCacheService().set({
      key: `offers:${id}`,
      value: OffersSerde.serialize(o.details),
      ttlSecs: 3600 as Seconds,
    })
    if (result instanceof CacheServiceError) return result
    return new PersistedOffer(id, o.details)
  },

  get: async (id: OfferId): Promise<PersistedOffer | CacheServiceError> => {
    try {
      const result: string | CacheServiceError = await RedisCacheService().get({
        key: `offers:${id}`,
      })
      if (result instanceof CacheUndefinedError) return new OfferNotFound()
      if (result instanceof CacheServiceError) return result
      else return new PersistedOffer(id, OffersSerde.deserialize(result))
    } catch (err) {
      return parseRepositoryError(err)
    }
  },
}

export default Redis
