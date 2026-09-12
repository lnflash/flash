const mockGiftCardsConfig: { allowOpenLoop: boolean } = { allowOpenLoop: false }
const mockNotifyOpsEvent = jest.fn()
const mockResolveProvider = jest.fn()
const mockRead = jest.fn()
const mockReadProduct = jest.fn()

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

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOpsEvent(...args),
}))

jest.mock("@services/gift-cards", () => ({
  resolveGiftCardProviderIdForCountry: (...args: unknown[]) =>
    mockResolveProvider(...args),
}))

jest.mock("@services/gift-cards/catalog-cache", () => ({
  GiftCardCatalogCache: () => ({
    read: (...args: unknown[]) => mockRead(...args),
    readProduct: (...args: unknown[]) => mockReadProduct(...args),
  }),
}))

import {
  __resetGiftCardStaleEventsForTest,
  GIFT_CARD_LIST_DEFAULT_FIRST,
  GIFT_CARD_LIST_MAX_FIRST,
  GIFT_CARD_STALE_EVENT_COALESCE_MS,
  getGiftCardProduct,
  listGiftCardProducts,
} from "@app/gift-cards/list-products"
import {
  GiftCardCatalogUnavailableError,
  GiftCardProductNotFoundError,
  GiftCardProviderUnavailableError,
} from "@domain/gift-cards"

const NOW_MS = 1_800_000_000_000

const product = (id: string, over: Partial<GiftCardProduct> = {}): GiftCardProduct => ({
  id: `bitcoinCompany:${id}` as GiftCardProductId,
  providerId: "bitcoinCompany",
  providerProductId: id,
  name: id,
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

const AMAZON_25 = product("amz-25", {
  brand: "Amazon",
  name: "Amazon $25",
  categories: ["Shopping", "Retail"],
})
const AMAZON_50 = product("amz-50", {
  brand: "Amazon",
  name: "Amazon $50",
  categories: ["Shopping"],
})
const VISA = product("visa", {
  brand: "Visa",
  name: "Visa Prepaid",
  isOpenLoop: true,
  categories: ["Prepaid"],
})
const UBER = product("uber", { brand: "Uber", name: "Uber Eats", categories: ["Food"] })
const SOLD_OUT = product("app-store", {
  brand: "Apple",
  name: "App Store",
  inStock: false,
})
// Lower-case brand on purpose: sorting must not put it after every capitalised brand.
const NETFLIX = product("netflix", {
  brand: "netflix",
  name: "Netflix",
  categories: ["Entertainment"],
})

// Deliberately out of order so the sort has work to do.
const CATALOG = [UBER, VISA, NETFLIX, SOLD_OUT, AMAZON_50, AMAZON_25]

const ids = (res: unknown): string[] => {
  if (res instanceof Error) throw res
  return (res as { products: GiftCardProduct[] }).products.map((p) => p.id)
}

const cursorFor = (p: GiftCardProduct): string =>
  Buffer.from(p.id, "utf8").toString("base64")

const catalogRead = (over: { products?: GiftCardProduct[]; stale?: boolean } = {}) => ({
  products: over.products ?? CATALOG,
  syncedAt: new Date(NOW_MS - 1000),
  stale: over.stale ?? false,
})

let nowSpy: jest.SpyInstance<number, []>

beforeEach(() => {
  jest.clearAllMocks()
  __resetGiftCardStaleEventsForTest()
  mockGiftCardsConfig.allowOpenLoop = false
  nowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW_MS)
  mockResolveProvider.mockImplementation((cc: string) => {
    if (cc === "US") return "bitcoinCompany"
    if (cc === "JM") return "bitrefill"
    return new GiftCardProviderUnavailableError()
  })
  mockRead.mockResolvedValue(catalogRead())
  mockReadProduct.mockResolvedValue(AMAZON_25)
})

afterEach(() => {
  nowSpy.mockRestore()
})

describe("listGiftCardProducts", () => {
  describe("filtering", () => {
    it("hides out-of-stock products", async () => {
      const res = await listGiftCardProducts({ countryCode: "US" })

      expect(ids(res)).not.toContain(SOLD_OUT.id)
    })

    it("hides open-loop cards while giftCards.allowOpenLoop is off", async () => {
      const res = await listGiftCardProducts({ countryCode: "US" })

      expect(ids(res)).not.toContain(VISA.id)
    })

    it("shows open-loop cards once giftCards.allowOpenLoop is on", async () => {
      mockGiftCardsConfig.allowOpenLoop = true

      const res = await listGiftCardProducts({ countryCode: "US" })

      expect(ids(res)).toContain(VISA.id)
    })

    it("matches category exactly, ignoring case", async () => {
      expect(
        ids(await listGiftCardProducts({ countryCode: "US", category: "shopping" })),
      ).toEqual([AMAZON_25.id, AMAZON_50.id])
      expect(
        ids(await listGiftCardProducts({ countryCode: "US", category: "RETAIL" })),
      ).toEqual([AMAZON_25.id])
      // Exact, not substring: "shop" is not a category anyone has.
      expect(
        ids(await listGiftCardProducts({ countryCode: "US", category: "shop" })),
      ).toEqual([])
    })

    it("searches name OR brand by case-insensitive substring", async () => {
      expect(
        ids(await listGiftCardProducts({ countryCode: "US", search: "AMAZ" })),
      ).toEqual([AMAZON_25.id, AMAZON_50.id])
      // "Eats" is only in the name, "Uber" is in both.
      expect(
        ids(await listGiftCardProducts({ countryCode: "US", search: "eats" })),
      ).toEqual([UBER.id])
      expect(
        ids(await listGiftCardProducts({ countryCode: "US", search: "zzz" })),
      ).toEqual([])
    })

    it("treats blank category and search as absent", async () => {
      const all = ids(await listGiftCardProducts({ countryCode: "US" }))

      expect(
        ids(await listGiftCardProducts({ countryCode: "US", category: "  " })),
      ).toEqual(all)
      expect(ids(await listGiftCardProducts({ countryCode: "US", search: "" }))).toEqual(
        all,
      )
    })

    it("applies category and search together", async () => {
      const res = await listGiftCardProducts({
        countryCode: "US",
        category: "shopping",
        search: "$50",
      })

      expect(ids(res)).toEqual([AMAZON_50.id])
    })
  })

  describe("ordering", () => {
    it("sorts by brand, then name, then id, ignoring case on the human fields", async () => {
      const res = await listGiftCardProducts({ countryCode: "US" })

      expect(ids(res)).toEqual([AMAZON_25.id, AMAZON_50.id, NETFLIX.id, UBER.id])
    })

    it("breaks a brand+name tie on id so the order is total", async () => {
      const twinA = product("twin-a", { brand: "Twin", name: "Twin" })
      const twinB = product("twin-b", { brand: "Twin", name: "Twin" })
      mockRead.mockResolvedValue(catalogRead({ products: [twinB, twinA] }))

      const res = await listGiftCardProducts({ countryCode: "US" })

      expect(ids(res)).toEqual([twinA.id, twinB.id])
    })
  })

  describe("pagination", () => {
    it("pages forward with an opaque cursor and reports whether more follow", async () => {
      const page1 = await listGiftCardProducts({ countryCode: "US", first: 3 })
      if (page1 instanceof Error) throw page1

      expect(ids(page1)).toEqual([AMAZON_25.id, AMAZON_50.id, NETFLIX.id])
      expect(page1.hasNextPage).toBe(true)
      expect(page1.endCursor).toBe(cursorFor(NETFLIX))

      const page2 = await listGiftCardProducts({
        countryCode: "US",
        first: 3,
        after: page1.endCursor as string,
      })
      if (page2 instanceof Error) throw page2

      expect(ids(page2)).toEqual([UBER.id])
      expect(page2.hasNextPage).toBe(false)
      // The last page still names its last row so a client can resume later.
      expect(page2.endCursor).toBe(cursorFor(UBER))
    })

    it("walks the whole list with no gaps and no repeats", async () => {
      const seen: string[] = []
      let after: string | undefined
      for (let guard = 0; guard < 10; guard++) {
        const page = await listGiftCardProducts({ countryCode: "US", first: 1, after })
        if (page instanceof Error) throw page
        seen.push(...page.products.map((p) => p.id))
        if (!page.hasNextPage) break
        after = page.endCursor as string
      }

      expect(seen).toEqual([AMAZON_25.id, AMAZON_50.id, NETFLIX.id, UBER.id])
    })

    it("returns an empty page with a null cursor when nothing matches", async () => {
      const res = await listGiftCardProducts({ countryCode: "US", search: "zzz" })
      if (res instanceof Error) throw res

      expect(res).toEqual({
        products: [],
        hasNextPage: false,
        endCursor: null,
        stale: false,
      })
    })

    it("restarts from the top on a cursor whose product has left the catalog", async () => {
      // A repeat is survivable; a silent gap is not. Guessing a position for an
      // id we no longer hold would risk the gap.
      const gone = Buffer.from("bitcoinCompany:gone", "utf8").toString("base64")

      const res = await listGiftCardProducts({ countryCode: "US", first: 2, after: gone })

      expect(ids(res)).toEqual([AMAZON_25.id, AMAZON_50.id])
    })

    it("defaults `first` to 50 and caps it at 200", async () => {
      const many = Array.from({ length: 250 }, (_, i) =>
        product(`p-${String(i).padStart(3, "0")}`),
      )
      mockRead.mockResolvedValue(catalogRead({ products: many }))

      expect(GIFT_CARD_LIST_DEFAULT_FIRST).toBe(50)
      expect(GIFT_CARD_LIST_MAX_FIRST).toBe(200)

      expect(ids(await listGiftCardProducts({ countryCode: "US" }))).toHaveLength(50)
      expect(
        ids(await listGiftCardProducts({ countryCode: "US", first: 1000 })),
      ).toHaveLength(200)
      for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          ids(await listGiftCardProducts({ countryCode: "US", first: bad })),
        ).toHaveLength(50)
      }
      // Fractional counts are floored, not rejected.
      expect(
        ids(await listGiftCardProducts({ countryCode: "US", first: 2.9 })),
      ).toHaveLength(2)
    })
  })

  describe("routing", () => {
    it("normalises the country before resolving the provider and reading the cache", async () => {
      await listGiftCardProducts({ countryCode: " us " })

      expect(mockResolveProvider).toHaveBeenCalledWith("US")
      expect(mockRead).toHaveBeenCalledWith({
        providerId: "bitcoinCompany",
        countryCode: "US",
      })
    })

    it("returns GiftCardProviderUnavailableError for a country no enabled provider serves", async () => {
      const res = await listGiftCardProducts({ countryCode: "XX" })

      expect(res).toBeInstanceOf(GiftCardProviderUnavailableError)
      expect(mockRead).not.toHaveBeenCalled()
    })

    it("passes a catalog-unavailable error straight through", async () => {
      const unavailable = new GiftCardCatalogUnavailableError()
      mockRead.mockResolvedValue(unavailable)

      const res = await listGiftCardProducts({ countryCode: "US" })

      expect(res).toBe(unavailable)
    })
  })

  describe("stale catalog", () => {
    it("serves a stale catalog, flags it, and posts ONE ops event per provider per 10 minutes", async () => {
      mockRead.mockResolvedValue(catalogRead({ stale: true }))

      const first = await listGiftCardProducts({ countryCode: "US" })
      const second = await listGiftCardProducts({ countryCode: "US", search: "uber" })
      if (first instanceof Error || second instanceof Error) throw new Error("unexpected")

      expect(first.stale).toBe(true)
      expect(first.products).toHaveLength(4)
      expect(second.stale).toBe(true)
      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith({
        flow: "giftcard",
        phase: "catalog-stale",
        status: "pending",
        meta: { providerId: "bitcoinCompany", countryCode: "US" },
      })

      // Window closed: the next stale read posts again.
      nowSpy.mockReturnValue(NOW_MS + GIFT_CARD_STALE_EVENT_COALESCE_MS)
      await listGiftCardProducts({ countryCode: "US" })
      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(2)
    })

    it("coalesces per provider, not globally", async () => {
      mockRead.mockResolvedValue(catalogRead({ stale: true }))

      await listGiftCardProducts({ countryCode: "US" })
      await listGiftCardProducts({ countryCode: "JM" })

      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(2)
      expect(mockNotifyOpsEvent.mock.calls.map((c) => c[0].meta.providerId)).toEqual([
        "bitcoinCompany",
        "bitrefill",
      ])
    })

    it("posts nothing for a fresh catalog", async () => {
      const res = await listGiftCardProducts({ countryCode: "US" })
      if (res instanceof Error) throw res

      expect(res.stale).toBe(false)
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    })
  })
})

describe("getGiftCardProduct", () => {
  it("returns the cached product for a well-formed id", async () => {
    const res = await getGiftCardProduct(AMAZON_25.id)

    expect(res).toEqual(AMAZON_25)
    expect(mockReadProduct).toHaveBeenCalledWith(AMAZON_25.id)
  })

  it("rejects a malformed id before touching the cache", async () => {
    for (const bad of ["amz-25", "bitcoinCompany:", ":amz-25", "acme:amz-25"]) {
      const res = await getGiftCardProduct(bad as GiftCardProductId)
      expect(res).toBeInstanceOf(GiftCardProductNotFoundError)
    }
    expect(mockReadProduct).not.toHaveBeenCalled()
  })

  it("passes a cache miss through as GiftCardProductNotFoundError", async () => {
    const miss = new GiftCardProductNotFoundError()
    mockReadProduct.mockResolvedValue(miss)

    expect(await getGiftCardProduct(AMAZON_25.id)).toBe(miss)
  })

  it("passes a catalog-unavailable error through unchanged", async () => {
    const unavailable = new GiftCardCatalogUnavailableError()
    mockReadProduct.mockResolvedValue(unavailable)

    expect(await getGiftCardProduct(AMAZON_25.id)).toBe(unavailable)
  })

  it("answers not-found for an open-loop card while allowOpenLoop is off", async () => {
    // Same answer as a card that never existed: a distinct "withheld" answer
    // would tell a client exactly which ids become reachable when the flag flips.
    mockReadProduct.mockResolvedValue(VISA)

    expect(await getGiftCardProduct(VISA.id)).toBeInstanceOf(GiftCardProductNotFoundError)

    mockGiftCardsConfig.allowOpenLoop = true
    expect(await getGiftCardProduct(VISA.id)).toEqual(VISA)
  })
})
