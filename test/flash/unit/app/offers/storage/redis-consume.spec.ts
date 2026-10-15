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

// A v4 UUID, the shape Storage.add mints with randomUUID().
const offerId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as OfferId
const offerKey = `offers:${offerId}`
const executedKey = `offer-executed:${offerId}`

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

// An in-memory Redis behind all three cache mocks. Values are JSON encoded the
// way ioredis-cache encodes them, so a tombstone reads back exactly as it would
// in production, and a DEL removes a key for one caller only.
const useInMemoryRedis = (): Map<string, string> => {
  const store = new Map<string, string>()
  mockCacheSet.mockImplementation(
    async ({ key, value }: { key: string; value: unknown }) => {
      store.set(key, JSON.stringify(value))
      return value
    },
  )
  mockCacheGet.mockImplementation(async ({ key }: { key: string }) => {
    const data = store.get(key)
    return data === undefined ? new CacheUndefinedError() : JSON.parse(data)
  })
  mockConsumeCacheKey.mockImplementation(async ({ key }: { key: string }) =>
    store.delete(key),
  )
  return store
}

describe("offer storage: single-use consume", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    stubRedis({})
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

  // initiateCashout hands the client's offerId straight to get. When the
  // tombstone lived at offers:executed:<id>, the id "executed:<id>" named it,
  // and get returned it as an offer whose details were the number 1.
  describe("offer ids are client input", () => {
    const addOffer = async (): Promise<OfferId> => {
      const added = await Storage.add({ details } as Parameters<typeof Storage.add>[0])
      if (added instanceof Error) throw added
      return added.id
    }

    it("does not return a consumed offer's tombstone as an offer", async () => {
      useInMemoryRedis()
      const id = await addOffer()
      expect(await Storage.consume(id)).toBe(true)

      const forged = await Storage.get(`executed:${id}` as OfferId)

      expect(forged).toBeInstanceOf(OfferNotFound)
      expect(forged).not.toBeInstanceOf(PersistedOffer)
      expect(await Storage.get(id)).toBeInstanceOf(OfferAlreadyExecuted)
    })

    it("keeps nothing but offer records under offers:", async () => {
      const store = useInMemoryRedis()
      const id = await addOffer()

      await Storage.consume(id)

      // the offer record is gone and only its tombstone is left, elsewhere
      expect(store.size).toBe(1)
      expect([...store.keys()].filter((key) => key.startsWith("offers:"))).toEqual([])
    })

    it.each([
      ["a tombstone name", `executed:${offerId}`],
      ["a UUID with a suffix", `${offerId}:x`],
      ["a key pattern", "*"],
      ["an empty id", ""],
    ])("refuses %s before it reaches a Redis key", async (_label, id) => {
      const fetched = await Storage.get(id as OfferId)
      const consumed = await Storage.consume(id as OfferId)

      expect(fetched).toBeInstanceOf(OfferNotFound)
      expect(consumed).toBeInstanceOf(OfferNotFound)
      expect(mockCacheGet).not.toHaveBeenCalled()
      expect(mockCacheSet).not.toHaveBeenCalled()
      expect(mockConsumeCacheKey).not.toHaveBeenCalled()
    })
  })
})
