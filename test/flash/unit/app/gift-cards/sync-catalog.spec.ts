const mockNotifyOpsEvent = jest.fn()
const mockWrite = jest.fn()
const mockEnabledProviders = jest.fn()
const mockRedisSet = jest.fn()
const mockRedisEval = jest.fn()
const mockRedisDel = jest.fn()

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({ fns }: { fns: unknown }) => fns,
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOpsEvent(...args),
}))

jest.mock("@services/gift-cards", () => ({
  enabledGiftCardProviders: (...args: unknown[]) => mockEnabledProviders(...args),
}))

jest.mock("@services/gift-cards/catalog-cache", () => ({
  GiftCardCatalogCache: () => ({
    write: (...args: unknown[]) => mockWrite(...args),
  }),
}))

jest.mock("@services/redis", () => ({
  redis: {
    set: (...args: unknown[]) => mockRedisSet(...args),
    eval: (...args: unknown[]) => mockRedisEval(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  },
}))

import {
  GIFT_CARD_CATALOG_SYNC_LOCK_KEY,
  GIFT_CARD_CATALOG_SYNC_LOCK_TTL_SECONDS,
  GIFT_CARD_CATALOG_SYNC_MARKER_KEY,
  syncGiftCardCatalogForProvider,
  syncGiftCardCatalogs,
} from "@app/gift-cards/sync-catalog"
import {
  GiftCardCatalogUnavailableError,
  GiftCardVendorUnavailableError,
  UnknownGiftCardError,
} from "@domain/gift-cards"
import { baseLogger } from "@services/logger"

const product = (
  providerId: GiftCardProviderId,
  id: string,
  countryCode = "US",
): GiftCardProduct => ({
  id: `${providerId}:${id}` as GiftCardProductId,
  providerId,
  providerProductId: id,
  name: `${id} card`,
  brand: id,
  countryCode,
  currency: "USD",
  denominationType: "fixed",
  denominations: [2500],
  minValue: null,
  maxValue: null,
  isOpenLoop: false,
  categories: [],
  logoUrl: null,
  termsUrl: null,
  rewardBps: 0,
  inStock: true,
  maxQuantity: 1,
  wholeUnitsOnly: false,
})

const provider = (
  id: GiftCardProviderId,
  listProducts: jest.Mock,
): IGiftCardProvider & { listProducts: jest.Mock } => ({
  id,
  listProducts,
  quote: jest.fn(),
  createOrder: jest.fn(),
  getOrder: jest.fn(),
})

const BITCOIN_COMPANY_PRODUCTS = [
  product("bitcoinCompany", "amazon", "US"),
  product("bitcoinCompany", "digicel", "JM"),
]

const opsEvents = () => mockNotifyOpsEvent.mock.calls.map((call) => call[0])

// The lock's SET and the marker's SET go through the same mock; tell them apart
// by key so a test can hold one and grant the other.
const grantRedisSet = (answers: { lock?: "OK" | null; marker?: "OK" | null } = {}) => {
  // `null` is Redis saying "NX: already set", so it must survive — no `??` here.
  mockRedisSet.mockImplementation(async (key: string) => {
    if (key === GIFT_CARD_CATALOG_SYNC_LOCK_KEY) {
      return answers.lock === undefined ? "OK" : answers.lock
    }
    if (key === GIFT_CARD_CATALOG_SYNC_MARKER_KEY) {
      return answers.marker === undefined ? "OK" : answers.marker
    }
    return "OK"
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  grantRedisSet()
  mockRedisEval.mockResolvedValue(1)
  mockRedisDel.mockResolvedValue(1)
  mockWrite.mockImplementation(async ({ products }: { products: GiftCardProduct[] }) => ({
    countries: [...new Set(products.map((p) => p.countryCode))],
  }))
  mockEnabledProviders.mockReturnValue([])
})

describe("syncGiftCardCatalogForProvider", () => {
  it("writes the vendor catalog to the cache and reports the counts", async () => {
    const tbc = provider(
      "bitcoinCompany",
      jest.fn().mockResolvedValue(BITCOIN_COMPANY_PRODUCTS),
    )

    const res = await syncGiftCardCatalogForProvider(tbc)

    expect(res).toEqual({
      providerId: "bitcoinCompany",
      products: 2,
      countries: 2,
      durationMs: expect.any(Number),
    })
    expect(mockWrite).toHaveBeenCalledWith({
      providerId: "bitcoinCompany",
      products: BITCOIN_COMPANY_PRODUCTS,
      syncedAt: expect.any(Date),
    })
    expect(opsEvents()).toEqual([
      {
        flow: "giftcard",
        phase: "catalog-synced",
        status: "success",
        meta: expect.objectContaining({
          providerId: "bitcoinCompany",
          products: "2",
          countries: "2",
        }),
      },
    ])
  })

  it("reports a vendor failure, writes nothing, and returns the error", async () => {
    const vendorDown = new GiftCardVendorUnavailableError()
    const tbc = provider("bitcoinCompany", jest.fn().mockResolvedValue(vendorDown))

    const res = await syncGiftCardCatalogForProvider(tbc)

    expect(res).toBe(vendorDown)
    expect(mockWrite).not.toHaveBeenCalled()
    expect(opsEvents()).toEqual([
      {
        flow: "giftcard",
        phase: "catalog-sync-failed",
        status: "failed",
        error: "GiftCardVendorUnavailableError",
        meta: { providerId: "bitcoinCompany" },
      },
    ])
  })

  it("treats an empty catalog as a failed sync: nothing written, failure event emitted", async () => {
    // A vendor that answers 200 with zero rows is a failed pull, not a catalog.
    // Writing it would blank the countries index and every listing until the
    // next sync; the last good catalog must keep serving instead.
    const tbc = provider("bitcoinCompany", jest.fn().mockResolvedValue([]))

    const res = await syncGiftCardCatalogForProvider(tbc)

    expect(res).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(mockWrite).not.toHaveBeenCalled()
    expect(opsEvents()).toEqual([
      {
        flow: "giftcard",
        phase: "catalog-sync-failed",
        status: "failed",
        error: "GiftCardVendorUnavailableError",
        meta: { providerId: "bitcoinCompany" },
      },
    ])
  })

  it("turns an adapter that THROWS into UnknownGiftCardError instead of propagating", async () => {
    // The port contract is return-not-throw; a vendor SDK bug that throws anyway
    // must still surface as one provider's failure, not as a crash of the run.
    const tbc = provider(
      "bitcoinCompany",
      jest.fn().mockRejectedValue(new Error("ECONNRESET")),
    )

    const res = await syncGiftCardCatalogForProvider(tbc)

    expect(res).toBeInstanceOf(UnknownGiftCardError)
    expect(opsEvents()[0]).toMatchObject({
      phase: "catalog-sync-failed",
      status: "failed",
      error: "UnknownGiftCardError",
    })
  })

  it("reports a cache write failure as a failed sync", async () => {
    const cacheDown = new GiftCardCatalogUnavailableError()
    mockWrite.mockResolvedValue(cacheDown)
    const tbc = provider(
      "bitcoinCompany",
      jest.fn().mockResolvedValue(BITCOIN_COMPANY_PRODUCTS),
    )

    const res = await syncGiftCardCatalogForProvider(tbc)

    expect(res).toBe(cacheDown)
    expect(opsEvents()[0]).toMatchObject({
      phase: "catalog-sync-failed",
      error: "GiftCardCatalogUnavailableError",
    })
  })
})

describe("syncGiftCardCatalogs", () => {
  it("syncs every enabled provider even when one fails, with an ops event for each", async () => {
    const tbc = provider(
      "bitcoinCompany",
      jest.fn().mockResolvedValue(BITCOIN_COMPANY_PRODUCTS),
    )
    const bitrefill = provider(
      "bitrefill",
      jest.fn().mockResolvedValue(new GiftCardVendorUnavailableError()),
    )
    mockEnabledProviders.mockReturnValue([bitrefill, tbc])

    const summaries = await syncGiftCardCatalogs()

    expect(bitrefill.listProducts).toHaveBeenCalledTimes(1)
    expect(tbc.listProducts).toHaveBeenCalledTimes(1)
    expect(summaries).toEqual([
      expect.objectContaining({
        providerId: "bitcoinCompany",
        products: 2,
        countries: 2,
      }),
    ])
    expect(opsEvents()).toEqual([
      expect.objectContaining({
        phase: "catalog-sync-failed",
        status: "failed",
        meta: { providerId: "bitrefill" },
      }),
      expect.objectContaining({
        phase: "catalog-synced",
        status: "success",
        meta: expect.objectContaining({ providerId: "bitcoinCompany" }),
      }),
    ])
  })

  it("takes the distributed lock with a 10 minute TTL and releases only its own token", async () => {
    mockEnabledProviders.mockReturnValue([])

    await syncGiftCardCatalogs()

    const lockCall = mockRedisSet.mock.calls.find(
      (call) => call[0] === GIFT_CARD_CATALOG_SYNC_LOCK_KEY,
    )
    expect(lockCall).toEqual([
      GIFT_CARD_CATALOG_SYNC_LOCK_KEY,
      expect.any(String),
      "EX",
      GIFT_CARD_CATALOG_SYNC_LOCK_TTL_SECONDS,
      "NX",
    ])
    expect(GIFT_CARD_CATALOG_SYNC_LOCK_TTL_SECONDS).toBe(600)

    // Owner-checked release: the script compares the stored value to OUR token.
    const token = lockCall?.[1]
    expect(mockRedisEval).toHaveBeenCalledTimes(1)
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("del"),
      1,
      GIFT_CARD_CATALOG_SYNC_LOCK_KEY,
      token,
    )
  })

  it("does no work when another run holds the lock", async () => {
    grantRedisSet({ lock: null })
    const tbc = provider(
      "bitcoinCompany",
      jest.fn().mockResolvedValue(BITCOIN_COMPANY_PRODUCTS),
    )
    mockEnabledProviders.mockReturnValue([tbc])

    const summaries = await syncGiftCardCatalogs()

    expect(summaries).toEqual([])
    expect(tbc.listProducts).not.toHaveBeenCalled()
    expect(mockWrite).not.toHaveBeenCalled()
    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    // Not ours to release.
    expect(mockRedisEval).not.toHaveBeenCalled()
    expect(baseLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("holds the lock"),
    )
  })

  it("releases the lock even when every provider fails", async () => {
    const tbc = provider(
      "bitcoinCompany",
      jest.fn().mockResolvedValue(new GiftCardVendorUnavailableError()),
    )
    mockEnabledProviders.mockReturnValue([tbc])

    const summaries = await syncGiftCardCatalogs()

    expect(summaries).toEqual([])
    expect(mockRedisEval).toHaveBeenCalledTimes(1)
  })

  it("skips, without throwing, when Redis is unreachable for the lock", async () => {
    mockRedisSet.mockRejectedValue(new Error("ECONNREFUSED"))
    const tbc = provider(
      "bitcoinCompany",
      jest.fn().mockResolvedValue(BITCOIN_COMPANY_PRODUCTS),
    )
    mockEnabledProviders.mockReturnValue([tbc])

    await expect(syncGiftCardCatalogs()).resolves.toEqual([])

    expect(tbc.listProducts).not.toHaveBeenCalled()
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("lock unavailable"),
    )
  })

  it("never throws, and still releases the lock, when the registry itself blows up", async () => {
    mockEnabledProviders.mockImplementation(() => {
      throw new Error("registry exploded")
    })

    await expect(syncGiftCardCatalogs()).resolves.toEqual([])

    expect(mockRedisEval).toHaveBeenCalledTimes(1)
    expect(baseLogger.error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("crashed"),
    )
  })

  describe("minIntervalSeconds", () => {
    const INTERVAL = 21600

    it("claims the interval marker for exactly the interval when a run is due", async () => {
      const tbc = provider(
        "bitcoinCompany",
        jest.fn().mockResolvedValue(BITCOIN_COMPANY_PRODUCTS),
      )
      mockEnabledProviders.mockReturnValue([tbc])

      const summaries = await syncGiftCardCatalogs({ minIntervalSeconds: INTERVAL })

      expect(summaries).toHaveLength(1)
      expect(mockRedisSet).toHaveBeenCalledWith(
        GIFT_CARD_CATALOG_SYNC_MARKER_KEY,
        expect.any(String),
        "EX",
        INTERVAL,
        "NX",
      )
      // A successful run keeps the marker so the next tick waits out the interval.
      expect(mockRedisDel).not.toHaveBeenCalled()
    })

    it("skips the run when a sync finished within the interval", async () => {
      grantRedisSet({ marker: null })
      const tbc = provider(
        "bitcoinCompany",
        jest.fn().mockResolvedValue(BITCOIN_COMPANY_PRODUCTS),
      )
      mockEnabledProviders.mockReturnValue([tbc])

      const summaries = await syncGiftCardCatalogs({ minIntervalSeconds: INTERVAL })

      expect(summaries).toEqual([])
      expect(tbc.listProducts).not.toHaveBeenCalled()
      // The lock WAS ours this time, so it is released.
      expect(mockRedisEval).toHaveBeenCalledTimes(1)
      expect(baseLogger.info).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("within the interval"),
      )
    })

    it("frees the marker when nothing synced so the next tick retries instead of waiting", async () => {
      const tbc = provider(
        "bitcoinCompany",
        jest.fn().mockResolvedValue(new GiftCardVendorUnavailableError()),
      )
      mockEnabledProviders.mockReturnValue([tbc])

      await syncGiftCardCatalogs({ minIntervalSeconds: INTERVAL })

      expect(mockRedisDel).toHaveBeenCalledWith(GIFT_CARD_CATALOG_SYNC_MARKER_KEY)
    })

    it("frees the marker when the only provider returned an empty catalog", async () => {
      const tbc = provider("bitcoinCompany", jest.fn().mockResolvedValue([]))
      mockEnabledProviders.mockReturnValue([tbc])

      const summaries = await syncGiftCardCatalogs({ minIntervalSeconds: INTERVAL })

      expect(summaries).toEqual([])
      expect(mockWrite).not.toHaveBeenCalled()
      expect(mockRedisDel).toHaveBeenCalledWith(GIFT_CARD_CATALOG_SYNC_MARKER_KEY)
    })

    it("does not touch the marker when the interval is not requested", async () => {
      mockEnabledProviders.mockReturnValue([])

      await syncGiftCardCatalogs()

      const markerCalls = mockRedisSet.mock.calls.filter(
        (call) => call[0] === GIFT_CARD_CATALOG_SYNC_MARKER_KEY,
      )
      expect(markerCalls).toHaveLength(0)
    })
  })
})
