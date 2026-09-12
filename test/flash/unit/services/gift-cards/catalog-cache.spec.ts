const mockGiftCardsConfig = {
  catalog: { syncIntervalSeconds: 21600, ttlSeconds: 21600, staleAfterSeconds: 86400 },
}

// In-memory stand-in for RedisCacheService. Values round-trip through JSON
// exactly as ioredis-cache does, so a Date written comes back as a string —
// which is the behaviour the cache module has to undo.
const mockStore = new Map<string, { value: unknown; ttlSecs: number }>()
const mockWriteOrder: string[] = []
const mockFailures = { set: false, get: false }

jest.mock("@config", () => ({
  get GiftCardsConfig() {
    return mockGiftCardsConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({ fns }: { fns: unknown }) => fns,
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/cache", () => {
  const { CacheUndefinedError, UnknownCacheServiceError } =
    jest.requireActual("@domain/cache")
  const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value))
  return {
    RedisCacheService: () => ({
      set: async ({
        key,
        value,
        ttlSecs,
      }: {
        key: string
        value: unknown
        ttlSecs: number
      }) => {
        if (mockFailures.set) return new UnknownCacheServiceError("redis down")
        mockStore.set(key, { value: roundTrip(value), ttlSecs })
        mockWriteOrder.push(key)
        return value
      },
      get: async ({ key }: { key: string }) => {
        if (mockFailures.get) return new UnknownCacheServiceError("redis down")
        const hit = mockStore.get(key)
        return hit ? roundTrip(hit.value) : new CacheUndefinedError()
      },
      clear: async ({ key }: { key: string }) => {
        mockStore.delete(key)
        return true
      },
    }),
  }
})

import {
  GiftCardCatalogUnavailableError,
  GiftCardProductNotFoundError,
} from "@domain/gift-cards"
import {
  GiftCardCatalogCache,
  giftCardCatalogKey,
  giftCardCountriesKey,
  giftCardProductIdsKey,
  giftCardProductKey,
} from "@services/gift-cards/catalog-cache"
import { baseLogger } from "@services/logger"

const NOW_MS = 1_800_000_000_000
const TTL_MS = mockGiftCardsConfig.catalog.ttlSeconds * 1000
const PROVIDER: GiftCardProviderId = "bitcoinCompany"

const product = (id: string, over: Partial<GiftCardProduct> = {}): GiftCardProduct => ({
  id: `${PROVIDER}:${id}` as GiftCardProductId,
  providerId: PROVIDER,
  providerProductId: id,
  name: `${id} card`,
  brand: id,
  countryCode: "US",
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
  ...over,
})

/** A product as the sync wrote it BEFORE `maxQuantity` / `wholeUnitsOnly` existed. */
const legacyRow = (p: GiftCardProduct): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(p).filter(
      ([key]) => key !== "maxQuantity" && key !== "wholeUnitsOnly",
    ),
  )

const seed = (key: string, value: unknown) => mockStore.set(key, { value, ttlSecs: 1 })

const US_A = product("us-a")
const US_B = product("us-b")
// Lower-case on purpose: the vendor's casing must not leak into key names.
const JM_C = product("jm-c", { countryCode: "jm", currency: "JMD" })

const cache = GiftCardCatalogCache()
let nowSpy: jest.SpyInstance<number, []>

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.clear()
  mockWriteOrder.length = 0
  mockFailures.set = false
  mockFailures.get = false
  nowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW_MS)
})

afterEach(() => {
  nowSpy.mockRestore()
})

describe("GiftCardCatalogCache.write", () => {
  it("groups products by country and writes one catalog record per country", async () => {
    const res = await cache.write({
      providerId: PROVIDER,
      products: [US_A, JM_C, US_B],
      syncedAt: new Date(NOW_MS),
    })

    expect(res).toEqual({ countries: ["JM", "US"] })

    const us = mockStore.get(giftCardCatalogKey(PROVIDER, "US"))?.value as {
      syncedAt: string
      products: GiftCardProduct[]
    }
    expect(us.syncedAt).toBe(new Date(NOW_MS).toISOString())
    expect(us.products.map((p) => p.id)).toEqual([US_A.id, US_B.id])

    const jm = mockStore.get(giftCardCatalogKey(PROVIDER, "JM"))?.value as {
      products: GiftCardProduct[]
    }
    expect(jm.products.map((p) => p.id)).toEqual([JM_C.id])

    expect(mockStore.get(giftCardCountriesKey(PROVIDER))?.value).toEqual(["JM", "US"])
  })

  it("writes every product under its own key", async () => {
    await cache.write({
      providerId: PROVIDER,
      products: [US_A, JM_C, US_B],
      syncedAt: new Date(NOW_MS),
    })

    for (const p of [US_A, US_B, JM_C]) {
      expect(mockStore.get(giftCardProductKey(p.id))?.value).toEqual(p)
    }
  })

  it("writes the countries index LAST, after every catalog and product key", async () => {
    // A sync that dies half-way must not advertise a country whose catalog key
    // never landed. Ordering is the whole guarantee, so it is asserted directly.
    await cache.write({
      providerId: PROVIDER,
      products: [US_A, JM_C, US_B],
      syncedAt: new Date(NOW_MS),
    })

    expect(mockWriteOrder[mockWriteOrder.length - 1]).toBe(giftCardCountriesKey(PROVIDER))
    // The id set lands just before the index, after every product key it lists.
    expect(mockWriteOrder[mockWriteOrder.length - 2]).toBe(
      giftCardProductIdsKey(PROVIDER),
    )
    expect(mockWriteOrder).toHaveLength(7) // 2 catalogs + 3 products + ids + index
  })

  it("records the ids it wrote under the provider's product id set", async () => {
    await cache.write({
      providerId: PROVIDER,
      products: [US_B, JM_C, US_A],
      syncedAt: new Date(NOW_MS),
    })

    expect(mockStore.get(giftCardProductIdsKey(PROVIDER))?.value).toEqual(
      [US_A.id, US_B.id, JM_C.id].sort(),
    )
  })

  it("deletes product keys the previous sync wrote and this one did not", async () => {
    await cache.write({
      providerId: PROVIDER,
      products: [US_A, US_B, JM_C],
      syncedAt: new Date(NOW_MS),
    })

    await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS),
    })

    // Delisted: gone, so it can no longer be quoted or ordered.
    expect(mockStore.has(giftCardProductKey(US_B.id))).toBe(false)
    expect(mockStore.has(giftCardProductKey(JM_C.id))).toBe(false)
    expect(mockStore.get(giftCardProductKey(US_A.id))?.value).toEqual(US_A)
    expect(mockStore.get(giftCardProductIdsKey(PROVIDER))?.value).toEqual([US_A.id])
    expect(baseLogger.info).toHaveBeenCalledWith(
      { providerId: PROVIDER, delisted: 2 },
      expect.stringContaining("delisted"),
    )
  })

  it("deletes nothing it did not write: keys outside the id set are left alone", async () => {
    // No id set yet (first sync after deploy) and an unrelated product key.
    seed(giftCardProductKey(US_B.id), US_B)

    await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS),
    })

    expect(mockStore.has(giftCardProductKey(US_B.id))).toBe(true)
    expect(mockStore.get(giftCardProductIdsKey(PROVIDER))?.value).toEqual([US_A.id])
  })

  it("still writes, and skips the diff with a warning, when the id set cannot be read", async () => {
    mockFailures.get = true

    const res = await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS),
    })

    expect(res).toEqual({ countries: ["US"] })
    expect(mockStore.get(giftCardProductKey(US_A.id))?.value).toEqual(US_A)
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PROVIDER }),
      expect.stringContaining("skipping stale-key cleanup"),
    )
  })

  it("ignores an id set of the wrong shape rather than deleting by it", async () => {
    seed(giftCardProductIdsKey(PROVIDER), [{ nope: true }, 42])
    seed(giftCardProductKey(US_B.id), US_B)

    await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS),
    })

    expect(mockStore.has(giftCardProductKey(US_B.id))).toBe(true)
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PROVIDER }),
      expect.stringContaining("unexpected shape"),
    )
  })

  it("retains every key for staleAfterSeconds, not ttlSeconds", async () => {
    // ttlSeconds is the freshness horizon (served with stale=true past it);
    // staleAfterSeconds is when Redis may drop the data. Writing the shorter
    // one would make "stale but servable" impossible.
    await cache.write({
      providerId: PROVIDER,
      products: [US_A, JM_C],
      syncedAt: new Date(NOW_MS),
    })

    const ttls = [...mockStore.values()].map((entry) => entry.ttlSecs)
    expect(ttls).toHaveLength(6) // 2 catalogs + 2 products + ids + index
    expect(new Set(ttls)).toEqual(
      new Set([mockGiftCardsConfig.catalog.staleAfterSeconds]),
    )
  })

  it("returns GiftCardCatalogUnavailableError and skips the index when a write fails", async () => {
    mockFailures.set = true

    const res = await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS),
    })

    expect(res).toBeInstanceOf(GiftCardCatalogUnavailableError)
    expect(mockStore.has(giftCardCountriesKey(PROVIDER))).toBe(false)
  })

  it("writes an empty index for an empty catalog rather than failing", async () => {
    const res = await cache.write({
      providerId: PROVIDER,
      products: [],
      syncedAt: new Date(),
    })

    expect(res).toEqual({ countries: [] })
    expect(mockStore.get(giftCardCountriesKey(PROVIDER))?.value).toEqual([])
    expect(mockStore.get(giftCardProductIdsKey(PROVIDER))?.value).toEqual([])
  })
})

describe("GiftCardCatalogCache.read", () => {
  it("returns the products with syncedAt revived as a Date", async () => {
    const syncedAt = new Date(NOW_MS - 1000)
    await cache.write({ providerId: PROVIDER, products: [US_A, US_B], syncedAt })

    const res = await cache.read({ providerId: PROVIDER, countryCode: "US" })
    if (res instanceof Error) throw res

    expect(res.syncedAt).toBeInstanceOf(Date)
    expect(res.syncedAt.getTime()).toBe(syncedAt.getTime())
    expect(res.products).toEqual([US_A, US_B])
    expect(res.stale).toBe(false)
  })

  it("is fresh exactly at the ttl boundary and stale one millisecond past it", async () => {
    await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS - TTL_MS),
    })
    const atBoundary = await cache.read({ providerId: PROVIDER, countryCode: "US" })
    if (atBoundary instanceof Error) throw atBoundary
    expect(atBoundary.stale).toBe(false)

    await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS - TTL_MS - 1),
    })
    const pastBoundary = await cache.read({ providerId: PROVIDER, countryCode: "US" })
    if (pastBoundary instanceof Error) throw pastBoundary
    expect(pastBoundary.stale).toBe(true)
  })

  it("normalises the country code before looking up the key", async () => {
    await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS),
    })

    const res = await cache.read({ providerId: PROVIDER, countryCode: " us " })
    if (res instanceof Error) throw res

    expect(res.products).toEqual([US_A])
  })

  it("returns GiftCardCatalogUnavailableError when the key is missing", async () => {
    const res = await cache.read({ providerId: PROVIDER, countryCode: "US" })

    expect(res).toBeInstanceOf(GiftCardCatalogUnavailableError)
  })

  it("returns GiftCardCatalogUnavailableError when Redis cannot be read", async () => {
    await cache.write({
      providerId: PROVIDER,
      products: [US_A],
      syncedAt: new Date(NOW_MS),
    })
    mockFailures.get = true

    const res = await cache.read({ providerId: PROVIDER, countryCode: "US" })

    expect(res).toBeInstanceOf(GiftCardCatalogUnavailableError)
  })

  it("defaults maxQuantity and wholeUnitsOnly for rows cached before they existed", async () => {
    // The running cache must stay usable across the deploy that added the two
    // fields; the next sync writes real values.
    seed(giftCardCatalogKey(PROVIDER, "US"), {
      syncedAt: new Date(NOW_MS).toISOString(),
      products: [legacyRow(US_A), legacyRow(US_B)],
    })

    const res = await cache.read({ providerId: PROVIDER, countryCode: "US" })
    if (res instanceof Error) throw res

    expect(res.products).toEqual([US_A, US_B])
    expect(
      res.products.every((p) => p.maxQuantity === 1 && p.wholeUnitsOnly === false),
    ).toBe(true)
  })

  it("drops rows of an unexpected shape from a catalog record and serves the rest", async () => {
    seed(giftCardCatalogKey(PROVIDER, "US"), {
      syncedAt: new Date(NOW_MS).toISOString(),
      products: [US_A, { id: "bitcoinCompany:half-written" }, "garbage", US_B],
    })

    const res = await cache.read({ providerId: PROVIDER, countryCode: "US" })
    if (res instanceof Error) throw res

    expect(res.products).toEqual([US_A, US_B])
    expect(baseLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: PROVIDER,
        countryCode: "US",
        dropped: 2,
        kept: 2,
      }),
      expect.stringContaining("dropped"),
    )
  })

  it("refuses a record it cannot interpret rather than serving garbage", async () => {
    mockStore.set(giftCardCatalogKey(PROVIDER, "US"), {
      value: { products: "not-a-list" },
      ttlSecs: 1,
    })
    expect(await cache.read({ providerId: PROVIDER, countryCode: "US" })).toBeInstanceOf(
      GiftCardCatalogUnavailableError,
    )

    mockStore.set(giftCardCatalogKey(PROVIDER, "US"), {
      value: { syncedAt: "yesterday-ish", products: [] },
      ttlSecs: 1,
    })
    expect(await cache.read({ providerId: PROVIDER, countryCode: "US" })).toBeInstanceOf(
      GiftCardCatalogUnavailableError,
    )
  })
})

describe("GiftCardCatalogCache.readProduct", () => {
  it("returns the product written for that id", async () => {
    await cache.write({
      providerId: PROVIDER,
      products: [US_A, JM_C],
      syncedAt: new Date(),
    })

    expect(await cache.readProduct(JM_C.id)).toEqual(JM_C)
  })

  it("defaults maxQuantity and wholeUnitsOnly for a product cached before they existed", async () => {
    seed(giftCardProductKey(US_A.id), legacyRow(US_A))

    const res = await cache.readProduct(US_A.id)

    expect(res).toEqual(US_A)
    expect(res).toEqual(
      expect.objectContaining({ maxQuantity: 1, wholeUnitsOnly: false }),
    )
  })

  it("keeps the written maxQuantity and wholeUnitsOnly when present", async () => {
    const whole = product("whole", {
      denominationType: "variable",
      denominations: [],
      minValue: 500,
      maxValue: 5000,
      maxQuantity: 3,
      wholeUnitsOnly: true,
    })
    await cache.write({ providerId: PROVIDER, products: [whole], syncedAt: new Date() })

    expect(await cache.readProduct(whole.id)).toEqual(whole)
  })

  it.each([
    ["a non-object", "garbage"],
    [
      "a half-written product",
      { id: "bitcoinCompany:half", providerId: "bitcoinCompany" },
    ],
    ["an unknown provider id", { ...US_A, providerId: "someoneElse" }],
    ["an unknown denomination type", { ...US_A, denominationType: "tiered" }],
    ["a maxQuantity below 1", { ...US_A, maxQuantity: 0 }],
  ])(
    "returns GiftCardProductNotFoundError for %s rather than serving it",
    async (_label, raw) => {
      seed(giftCardProductKey(US_A.id), raw)

      const res = await cache.readProduct(US_A.id)

      expect(res).toBeInstanceOf(GiftCardProductNotFoundError)
      expect(baseLogger.error).toHaveBeenCalledWith(
        { productId: US_A.id },
        expect.stringContaining("unexpected shape"),
      )
    },
  )

  it("returns GiftCardProductNotFoundError on a miss", async () => {
    const res = await cache.readProduct("bitcoinCompany:nope" as GiftCardProductId)

    expect(res).toBeInstanceOf(GiftCardProductNotFoundError)
  })

  it("returns GiftCardCatalogUnavailableError when Redis cannot be read", async () => {
    mockFailures.get = true

    const res = await cache.readProduct(US_A.id)

    expect(res).toBeInstanceOf(GiftCardCatalogUnavailableError)
    expect(res).not.toBeInstanceOf(GiftCardProductNotFoundError)
  })
})
