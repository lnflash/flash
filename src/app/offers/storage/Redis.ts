import { randomUUID } from "crypto"

import {
  CacheServiceError,
  CacheUndefinedError,
  OfferAlreadyExecuted,
  OfferNotFound,
} from "@domain/cache"
import { RedisCacheService, consumeCacheKey } from "@services/cache"
import { baseLogger } from "@services/logger"

import ValidOffer from "../ValidOffer"

import { parseRepositoryError } from "../../../services/mongoose/utils"

import { OffersSerde } from "./OffersSerde"
import PersistedOffer from "./PersistedOffer"

const OFFER_TTL_SECS = 3600 as Seconds

const offerKey = (id: OfferId): string => `offers:${id}`
// Left behind when an offer is consumed, so a later attempt to execute it is
// told the offer was already used rather than that it never existed. It is for
// error specificity only: the DEL in `consume` alone decides who executes.
const executedKey = (id: OfferId): string => `offers:executed:${id}`

// The offer record is gone: it expired, never existed, or an execution consumed
// it. Only the last leaves a tombstone.
const missingOfferError = async (
  id: OfferId,
): Promise<OfferAlreadyExecuted | OfferNotFound> => {
  const tombstone = await RedisCacheService().get<string>({ key: executedKey(id) })
  if (tombstone instanceof CacheUndefinedError) return new OfferNotFound()
  if (tombstone instanceof CacheServiceError) {
    baseLogger.warn(
      { offerId: id, err: tombstone },
      "Could not read the executed-offer tombstone; reporting the offer as not found",
    )
    return new OfferNotFound()
  }
  return new OfferAlreadyExecuted()
}

const Redis = {
  add: async (o: ValidOffer): Promise<PersistedOffer | CacheServiceError> => {
    const id = randomUUID() as OfferId // could use hash of offer details with getOrSet
    const result = await RedisCacheService().set({
      key: offerKey(id),
      value: OffersSerde.serialize(o.details),
      ttlSecs: OFFER_TTL_SECS,
    })
    if (result instanceof CacheServiceError) return result
    return new PersistedOffer(id, o.details)
  },

  get: async (id: OfferId): Promise<PersistedOffer | CacheServiceError> => {
    try {
      const result: string | CacheServiceError = await RedisCacheService().get({
        key: offerKey(id),
      })
      if (result instanceof CacheUndefinedError) return await missingOfferError(id)
      if (result instanceof CacheServiceError) return result
      else return new PersistedOffer(id, OffersSerde.deserialize(result))
    } catch (err) {
      return parseRepositoryError(err)
    }
  },

  /**
   * Single-use gate for executing an offer: takes the record out of Redis with
   * one DEL, so exactly one caller per offer gets `true`. A concurrent
   * duplicate gets OfferAlreadyExecuted. A Redis error is returned as is, and
   * the caller must not execute an offer it could not consume (fail closed).
   */
  consume: async (
    id: OfferId,
  ): Promise<true | OfferAlreadyExecuted | CacheServiceError> => {
    // The tombstone goes first, so no retry can land between a won DEL and the
    // tombstone write. It is best effort. If it fails, a later retry sees
    // OfferNotFound instead of OfferAlreadyExecuted, and nothing is paid twice
    // either way. A tombstone left by a caller whose DEL then fails or loses is
    // harmless, because `get` reads it only once the offer record is gone.
    const tombstone = await RedisCacheService().set({
      key: executedKey(id),
      value: "1",
      ttlSecs: OFFER_TTL_SECS,
    })
    if (tombstone instanceof CacheServiceError) {
      baseLogger.warn(
        { offerId: id, err: tombstone },
        "Could not write the executed-offer tombstone; consuming the offer anyway",
      )
    }

    const consumed = await consumeCacheKey({ key: offerKey(id) })
    if (consumed instanceof CacheServiceError) return consumed
    // The caller read this offer moments ago, so a key that is already gone was
    // removed by a concurrent execution of the same offer (or, at the very edge
    // of its TTL, expired). Either way, this caller must not execute it.
    if (!consumed) return new OfferAlreadyExecuted()
    return true
  },
}

export default Redis
