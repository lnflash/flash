// ENG-695: an offer is executed at most once. Storage.consume takes the offer
// record out of Redis with a single DEL (consumeCacheKey); a tombstone left
// beside it lets a later attempt be told the offer was already used.

const mockCacheSet = jest.fn()
const mockCacheGet = jest.fn()
const mockConsumeCacheKey = jest.fn()
const mockLoggerWarn = jest.fn()

jest.mock("@services/cache", () => ({
  RedisCacheService: () => ({
    set: (...args: unknown[]) => mockCacheSet(...args),
    get: (...args: unknown[]) => mockCacheGet(...args),
  }),
  consumeCacheKey: (...args: unknown[]) => mockConsumeCacheKey(...args),
}))

jest.mock("@services/logger", () => ({
  baseLogger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}))

import PersistedOffer from "@app/offers/storage/PersistedOffer"
import { OffersSerde } from "@app/offers/storage/OffersSerde"
import Storage from "@app/offers/storage/Redis"
import { CashoutDetails } from "@app/offers/types"
import {
  CacheUndefinedError,
  OfferAlreadyExecuted,
  OfferNotFound,
  UnknownCacheServiceError,
} from "@domain/cache"
import { USDAmount } from "@domain/shared"

const offerId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as OfferId
const offerKey = `offers:${offerId}`
const executedKey = `offers:executed:${offerId}`

const usd = (cents: string) => {
  const amount = USDAmount.cents(cents)
  if (amount instanceof Error) throw amount
  return amount
}

const details: CashoutDetails = {
  payment: {
    userAcct: "22222222-2222-4222-8222-222222222222" as WalletId,
    flashAcct: "44444444-4444-4444-8444-444444444444" as WalletId,
    invoice: {
      paymentRequest: "lnbc1test" as Bolt11,
      expiresAt: new Date(Date.now() + 60_000),
    } as unknown as LnInvoice,
    amount: usd("100"),
  },
  payout: {
    bankAccountId: "12345 - First Global",
    amount: usd("98"),
    serviceFee: usd("2"),
  },
}

// Serve RedisCacheService().get from a key -> value map; a missing key reads as
// CacheUndefinedError, which is what the real service returns on a miss.
const stubRedis = (entries: Record<string, unknown>) =>
  mockCacheGet.mockImplementation(async ({ key }: { key: string }) =>
    key in entries ? entries[key] : new CacheUndefinedError(),
  )

describe("offer storage: single-use consume", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCacheSet.mockImplementation(async ({ value }: { value: unknown }) => value)
    mockConsumeCacheKey.mockResolvedValue(true)
  })

  describe("consume", () => {
    it("returns true for the caller whose DEL removed the offer", async () => {
      const result = await Storage.consume(offerId)

      expect(result).toBe(true)
      expect(mockConsumeCacheKey).toHaveBeenCalledTimes(1)
      expect(mockConsumeCacheKey).toHaveBeenCalledWith({ key: offerKey })
    })

    it("returns OfferAlreadyExecuted when a concurrent execution removed the offer first", async () => {
      mockConsumeCacheKey.mockResolvedValue(false)

      const result = await Storage.consume(offerId)

      expect(result).toBeInstanceOf(OfferAlreadyExecuted)
    })

    it("returns a Redis error on the DEL as is, so the caller fails closed", async () => {
      const redisDown = new UnknownCacheServiceError("connection reset")
      mockConsumeCacheKey.mockResolvedValue(redisDown)

      const result = await Storage.consume(offerId)

      expect(result).toBe(redisDown)
    })

    it("writes the tombstone, with the offer TTL, before the DEL", async () => {
      await Storage.consume(offerId)

      expect(mockCacheSet).toHaveBeenCalledTimes(1)
      expect(mockCacheSet).toHaveBeenCalledWith({
        key: executedKey,
        value: "1",
        ttlSecs: 3600,
      })
      expect(mockCacheSet.mock.invocationCallOrder[0]).toBeLessThan(
        mockConsumeCacheKey.mock.invocationCallOrder[0],
      )
    })

    it("still consumes the offer, and logs, when the tombstone write fails", async () => {
      mockCacheSet.mockResolvedValue(new UnknownCacheServiceError("timeout"))

      const result = await Storage.consume(offerId)

      expect(result).toBe(true)
      expect(mockConsumeCacheKey).toHaveBeenCalledWith({ key: offerKey })
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ offerId, err: expect.any(UnknownCacheServiceError) }),
        expect.any(String),
      )
    })
  })

  describe("get", () => {
    it("returns the stored offer without reading the tombstone", async () => {
      stubRedis({ [offerKey]: OffersSerde.serialize(details) })

      const result = await Storage.get(offerId)

      expect(result).toBeInstanceOf(PersistedOffer)
      if (!(result instanceof PersistedOffer)) throw result
      expect(result.id).toBe(offerId)
      expect(result.details.payout.bankAccountId).toBe(details.payout.bankAccountId)
      expect(mockCacheGet).toHaveBeenCalledTimes(1)
      expect(mockCacheGet).toHaveBeenCalledWith({ key: offerKey })
    })

    it("returns OfferAlreadyExecuted when the offer is gone and its tombstone is present", async () => {
      stubRedis({ [executedKey]: "1" })

      const result = await Storage.get(offerId)

      expect(result).toBeInstanceOf(OfferAlreadyExecuted)
      expect(mockCacheGet).toHaveBeenCalledWith({ key: executedKey })
    })

    it("returns OfferNotFound when the offer is gone and there is no tombstone", async () => {
      stubRedis({})

      const result = await Storage.get(offerId)

      expect(result).toBeInstanceOf(OfferNotFound)
      expect(result).not.toBeInstanceOf(OfferAlreadyExecuted)
    })

    it("returns OfferNotFound, and logs, when the tombstone cannot be read", async () => {
      stubRedis({ [executedKey]: new UnknownCacheServiceError("timeout") })

      const result = await Storage.get(offerId)

      expect(result).toBeInstanceOf(OfferNotFound)
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ offerId }),
        expect.any(String),
      )
    })
  })

  describe("add", () => {
    it("stores the offer under offers:<id> with the one-hour TTL", async () => {
      const validOffer = { details } as Parameters<typeof Storage.add>[0]

      const result = await Storage.add(validOffer)

      expect(result).toBeInstanceOf(PersistedOffer)
      if (!(result instanceof PersistedOffer)) throw result
      expect(mockCacheSet).toHaveBeenCalledWith({
        key: `offers:${result.id}`,
        value: OffersSerde.serialize(details),
        ttlSecs: 3600,
      })
    })
  })
})
