import { parseRepositoryError } from "../../../services/mongoose/utils"
import PersistedOffer from "./PersistedOffer"
import ValidOffer from "../ValidOffer"
import { RedisCacheService } from "@services/cache"
import { CacheServiceError, CacheUndefinedError, OfferNotFound } from "@domain/cache"
import { baseLogger } from "@services/logger"
import { randomUUID } from "crypto"
import { JMDAmount, MoneyAmount, USDAmount } from "@domain/shared"
import { CashoutDetails } from "../types"

/**
 * Custom SerDe for CashoutDetails
 */
const OffersSerde = {
  serialize: (data: CashoutDetails): string => {
    return JSON.stringify(data, (_, value) => {
      if (value instanceof MoneyAmount) return value.toJson()
      else if (typeof value === "bigint") return value.toString();
      else return value
    });
  },

  // todo: Find better way to identify MoneyAmount
  deserialize: (json: string) => {
    return JSON.parse(
      json, 
      (key: string, value: any) => {
        if (['usd', 'jmd', 'fee'].includes(key.toLowerCase()) && Array.isArray(value)) {
          return MoneyAmount.fromJSON(value as [string, string])
        }
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