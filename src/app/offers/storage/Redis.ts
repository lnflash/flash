import { parseRepositoryError } from "../../../services/mongoose/utils"
import PersistedOffer from "./PersistedOffer"
import ValidOffer from "../ValidOffer"
import { RedisCacheService } from "@services/cache"
import { CacheServiceError, CacheUndefinedError, OfferNotFound } from "@domain/cache"
import { baseLogger } from "@services/logger"
import { randomUUID } from "crypto"

/**
 * Custom SerDe for BigInt
 */
const OffersSerde = {
  serialize: (data: any): string => {
    return JSON.stringify(data, (_, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
  },

  deserialize: (json: string) => {
    return JSON.parse(
      json, 
      (key: string, value: any) => {
        if (key.toLowerCase() === 'amount' && typeof value === 'string') {
            return BigInt(value);
        }
        return value;
    })
  }
}

const Redis = {
  add: async (o: ValidOffer): Promise<PersistedOffer | CacheServiceError> => {
    const id = randomUUID() as OfferId // could use hash of offer details with getOrSet
    const result= await RedisCacheService().set({
      key: `offers:${id}`,
      value: OffersSerde.serialize(o.details),
      ttlSecs: 3600 as Seconds
    });
    baseLogger.info(result, "result")
    if (result instanceof CacheServiceError) return result

    return new PersistedOffer(id, o.details)
  },
  
  get: async (id: OfferId): Promise<PersistedOffer | CacheServiceError> => {
    try {
      const result: string | CacheServiceError = await RedisCacheService().get({ key: `offers:${id}`})
      if (result instanceof CacheUndefinedError) return new OfferNotFound()
      if (result instanceof CacheServiceError) return result
      else return new PersistedOffer(id, OffersSerde.deserialize(result))
    } catch (err) {
      return parseRepositoryError(err)
    }
  }
}

export default Redis