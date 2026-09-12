const mockRedisStore = new Map<string, string>()

jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn((err) => Boolean(err?.isAxiosError)),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
  wrapAsyncFunctionsToRunInSpan: ({ fns }: { fns: unknown }) => fns,
}))

jest.mock("@config", () => ({
  GiftCardsConfig: jest.requireActual("./fixtures").giftCardsConfigFixture,
}))

jest.mock("@services/redis", () => ({
  redis: {
    get: async (key: string) => mockRedisStore.get(key) ?? null,
    set: async (key: string, value: string, ...opts: unknown[]) => {
      if (opts.includes("NX") && mockRedisStore.has(key)) return null
      mockRedisStore.set(key, value)
      return "OK"
    },
    del: async (key: string) => (mockRedisStore.delete(key) ? 1 : 0),
    eval: async (_script: string, _numKeys: number, key: string, nonce: string) => {
      if (mockRedisStore.get(key) === nonce) {
        mockRedisStore.delete(key)
        return 1
      }
      return 0
    },
  },
}))

import axios from "axios"

import {
  GiftCardInvalidValueError,
  GiftCardVendorUnavailableError,
  toGiftCardOrderId,
  toGiftCardProviderOrderId,
} from "@domain/gift-cards"
import {
  BITCOIN_COMPANY_MAX_QUANTITY,
  BitcoinCompanyProvider,
  RETRY_MAX,
  registerBitcoinCompanyProvider,
} from "@services/gift-cards/bitcoin-company"
import {
  __resetGiftCardProvidersForTest,
  getRegisteredGiftCardProvider,
} from "@services/gift-cards/registry"
import { baseLogger } from "@services/logger"

import { runGiftCardProviderContract } from "../provider-contract"

import {
  CLAIM_CODE,
  CLAIM_LINK,
  FULFILLED_RESULT,
  LOGIN_RESULT,
  NOW,
  PURCHASE_RESULT,
  RouteHandler,
  callsTo,
  catalogPage,
  httpError,
  httpOk,
  networkError,
  purchaseRoute,
  quoteCardRoute,
  routeGet,
  routePost,
  vendorProductFixture,
  vendorVariableProductFixture,
} from "./fixtures"

const mockedAxios = axios as unknown as { get: jest.Mock; post: jest.Mock }
const mockedLogger = baseLogger as unknown as Record<"info" | "warn" | "error", jest.Mock>

const noSleep = () => Promise.resolve()
const REFERENCE = toGiftCardOrderId("gco_contract_0001")

const makeProvider = () =>
  BitcoinCompanyProvider({
    clientDeps: { sleep: noSleep, now: () => NOW, random: () => 0 },
    now: () => new Date(NOW),
  })

const happyGet: Record<string, RouteHandler> = {
  "/giftcards": (ctx) =>
    catalogPage(
      Number(ctx.query.get("offset")) === 0
        ? [
            vendorProductFixture(),
            vendorVariableProductFixture(),
            vendorProductFixture({ id: "prod-no-country", countries: [] }),
          ]
        : [],
    ),
}

// Quote and purchase price by the quantity in the request body, so the "price
// of one" assertions below would fail if the adapter ever sent more than one.
const happyPost: Record<string, RouteHandler> = {
  "/auth/login": () => httpOk(LOGIN_RESULT),
  "/svs/quote-card": quoteCardRoute,
  "/giftcards/purchase/bitcoin": purchaseRoute,
  "/giftcards/invoice-status": () => httpOk(FULFILLED_RESULT),
}

const ORDER_REF = {
  providerOrderId: toGiftCardProviderOrderId(PURCHASE_RESULT.uuid),
  paymentRequest: PURCHASE_RESULT.invoice,
}

const arrangeHappyPath = () => {
  jest.clearAllMocks()
  mockRedisStore.clear()
  mockedAxios.get.mockReset().mockImplementation(routeGet(happyGet))
  mockedAxios.post.mockReset().mockImplementation(routePost(happyPost))
}

runGiftCardProviderContract("bitcoinCompany", makeProvider, {
  providerId: "bitcoinCompany",
  reference: REFERENCE,
  now: () => new Date(NOW),
  statusRequiresPaymentRequest: true,
  arrangeHappyPath,
  arrangeVendorDown: () => {
    mockedAxios.get.mockReset().mockRejectedValue(networkError())
    mockedAxios.post.mockReset().mockRejectedValue(networkError())
  },
  pickPurchase: (products) => {
    const product = products.find((p) => p.denominationType === "fixed")
    if (!product) throw new Error("fixture catalog has no fixed-denomination product")
    return { product, valueMinor: product.denominations[1], quantity: 1 }
  },
})

describe("bitcoinCompany adapter specifics", () => {
  beforeEach(arrangeHappyPath)

  it("maps the vendor catalog and counts every skip reason in the sync log", async () => {
    const products = await makeProvider().listProducts()
    if (products instanceof Error) throw products

    expect(products.map((p) => p.id)).toEqual([
      "bitcoinCompany:prod-amazon-us",
      "bitcoinCompany:prod-visa-us",
    ])
    // Single-card until a multi-card invoice-status fixture exists.
    expect(products.every((p) => p.maxQuantity === 1)).toBe(true)
    expect(BITCOIN_COMPANY_MAX_QUANTITY).toBe(1)
    expect(mockedLogger.info).toHaveBeenCalledWith(
      {
        provider: "bitcoinCompany",
        op: "listProducts",
        received: 3,
        kept: 2,
        skipped: {
          invalid: 0,
          noCountry: 1,
          physical: 0,
          noLightning: 0,
          unknownDenominationType: 0,
          noDenominations: 0,
        },
        flagged: { notResellable: 0 },
      },
      expect.any(String),
    )
  })

  it("skips physical and non-Lightning rows and counts rows that failed validation", async () => {
    mockedAxios.get.mockImplementation(
      routeGet({
        "/giftcards": (ctx) =>
          catalogPage(
            Number(ctx.query.get("offset")) === 0
              ? [
                  vendorProductFixture(),
                  vendorProductFixture({ id: "prod-physical", isPhysical: true }),
                  vendorProductFixture({ id: "prod-onchain", paymentTypes: ["OnChain"] }),
                  { id: 42, name: "broken" },
                ]
              : [],
          ),
      }),
    )

    const products = await makeProvider().listProducts()
    if (products instanceof Error) throw products

    expect(products.map((p) => p.id)).toEqual(["bitcoinCompany:prod-amazon-us"])
    expect(mockedLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        received: 4,
        kept: 1,
        skipped: expect.objectContaining({ invalid: 1, physical: 1, noLightning: 1 }),
      }),
      expect.any(String),
    )
  })

  it("keeps resellingEnabled=false rows (pre-KYB catalog) and warns with a count", async () => {
    mockedAxios.get.mockImplementation(
      routeGet({
        "/giftcards": (ctx) =>
          catalogPage(
            Number(ctx.query.get("offset")) === 0
              ? [
                  vendorProductFixture({ resellingEnabled: false }),
                  vendorVariableProductFixture({ resellingEnabled: false }),
                ]
              : [],
          ),
      }),
    )

    const products = await makeProvider().listProducts()
    if (products instanceof Error) throw products

    expect(products).toHaveLength(2)
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ op: "listProducts", notResellable: 2 }),
      expect.stringContaining("resellingEnabled=false"),
    )
    expect(mockedLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ kept: 2, flagged: { notResellable: 2 } }),
      expect.any(String),
    )
  })

  it("fails the sync when rows were received but none survived mapping", async () => {
    // Every row skipped is a vendor-side shape or policy change, not a
    // catalog. Returning [] would let the sync blank the read model.
    mockedAxios.get.mockImplementation(
      routeGet({
        "/giftcards": (ctx) =>
          catalogPage(
            Number(ctx.query.get("offset")) === 0
              ? [
                  vendorProductFixture({ id: "a", countries: [] }),
                  vendorProductFixture({ id: "b", isPhysical: true }),
                ]
              : [],
          ),
      }),
    )

    const result = await makeProvider().listProducts()

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "listProducts",
        received: 2,
        kept: 0,
        skipped: expect.objectContaining({ noCountry: 1, physical: 1 }),
      }),
      expect.stringContaining("kept none"),
    )
  })

  it("returns an empty list, not an error, when the vendor catalog itself is empty", async () => {
    // The sync job treats this as a failed pull; the adapter's job is only to
    // report what the vendor said.
    mockedAxios.get.mockImplementation(routeGet({ "/giftcards": () => catalogPage([]) }))

    expect(await makeProvider().listProducts()).toEqual([])
    expect(mockedLogger.error).not.toHaveBeenCalled()
  })

  it("sends major units, Lightning purchase type, and the order reference to the vendor", async () => {
    const provider = makeProvider()
    const products = await provider.listProducts()
    if (products instanceof Error) throw products
    const product = products[0]

    const quote = await provider.quote({ product, valueMinor: 2500, quantity: 1 })
    if (quote instanceof Error) throw quote
    const order = await provider.createOrder({
      product,
      valueMinor: 2500,
      quantity: 1,
      reference: REFERENCE,
    })
    if (order instanceof Error) throw order

    expect(callsTo(mockedAxios.post, "/svs/quote-card")[0][1]).toEqual({
      productId: "prod-amazon-us",
      cardValue: 25,
      quantity: 1,
      purchaseType: "Lightning",
    })
    expect(callsTo(mockedAxios.post, "/giftcards/purchase/bitcoin")[0][1]).toEqual({
      productId: "prod-amazon-us",
      cardValue: 25,
      quantity: 1,
      useUsdBalance: false,
      useSatsBalance: false,
      label: REFERENCE,
    })
    // The price of ONE card: the route handlers scale by quantity, so this
    // would fail if the adapter had sent more than one.
    expect(quote).toEqual(
      expect.objectContaining({
        productId: product.id,
        fiatCostMinor: 2500,
        satsCost: 39000,
        rewardSats: 585,
        bitcoinPriceMinor: 6410256,
        expiresAt: new Date(NOW + 60_000),
      }),
    )
    expect(order).toEqual({
      providerOrderId: PURCHASE_RESULT.uuid,
      paymentRequest: PURCHASE_RESULT.invoice,
      amountSats: 39000,
      // TBC reports no order expiry; the BOLT11's own expiry governs.
      expiresAt: null,
    })
  })

  it.each([
    [
      "quote",
      (p: IGiftCardProvider, product: GiftCardProduct) =>
        p.quote({ product, valueMinor: 2500, quantity: 2 }),
    ],
    [
      "createOrder",
      (p: IGiftCardProvider, product: GiftCardProduct) =>
        p.createOrder({ product, valueMinor: 2500, quantity: 2, reference: REFERENCE }),
    ],
  ])("%s refuses quantity 2 before calling the vendor", async (_op, call) => {
    const provider = makeProvider()
    const products = await provider.listProducts()
    if (products instanceof Error) throw products
    mockedAxios.post.mockClear()

    const result = await call(provider, products[0])

    expect(result).toBeInstanceOf(GiftCardInvalidValueError)
    expect((result as Error).message).toBe(
      "Only one card per order is supported for this provider",
    )
    // Not even a login: the guard sits in front of the client.
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("maps a completed vendor order to fulfilled with its claim", async () => {
    const status = await makeProvider().getOrder(ORDER_REF)

    expect(status).toEqual({
      kind: "fulfilled",
      claim: {
        codes: [{ label: "Claim code", value: CLAIM_CODE }],
        claimLink: CLAIM_LINK,
        barcode: null,
      },
    })
    expect(callsTo(mockedAxios.post, "/giftcards/invoice-status")[0][1]).toEqual({
      invoice: PURCHASE_RESULT.invoice,
    })
  })

  it("holds a completed order without claim data as pending and warns", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        ...happyPost,
        "/giftcards/invoice-status": () =>
          httpOk({ status: "Completed", claimData: null }),
      }),
    )

    const status = await makeProvider().getOrder({
      providerOrderId: toGiftCardProviderOrderId(PURCHASE_RESULT.uuid),
      paymentRequest: PURCHASE_RESULT.invoice,
    })

    expect(status).toEqual({ kind: "paidPendingFulfillment" })
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "getOrder",
        providerOrderId: PURCHASE_RESULT.uuid,
        vendorStatus: "Completed",
      }),
      expect.stringContaining("without claim data"),
    )
  })

  it("maps an unpaid vendor order to awaitingPayment", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        ...happyPost,
        "/giftcards/invoice-status": () => httpOk({ status: "Unpaid" }),
      }),
    )

    const status = await makeProvider().getOrder(ORDER_REF)

    expect(status).toEqual({ kind: "awaitingPayment" })
  })

  it("holds a Disputed order as pending with a warning rather than calling it refunded", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        ...happyPost,
        "/giftcards/invoice-status": () =>
          httpOk({ status: "Disputed", claimData: FULFILLED_RESULT.claimData }),
      }),
    )

    const status = await makeProvider().getOrder(ORDER_REF)

    expect(status).toEqual({ kind: "paidPendingFulfillment" })
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ op: "getOrder", vendorStatus: "Disputed" }),
      expect.stringContaining("Disputed"),
    )
  })

  it("getOrder retries a 5xx by default and makes exactly one attempt with retry: false", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        ...happyPost,
        "/giftcards/invoice-status": () => httpError(502, "Bad Gateway"),
      }),
    )
    const provider = makeProvider()

    const single = await provider.getOrder(ORDER_REF, { retry: false })
    expect(single).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(callsTo(mockedAxios.post, "/giftcards/invoice-status")).toHaveLength(1)

    const retried = await provider.getOrder(ORDER_REF)
    expect(retried).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(callsTo(mockedAxios.post, "/giftcards/invoice-status")).toHaveLength(
      1 + RETRY_MAX + 1,
    )
  })

  it("refuses a status lookup without a payment request and never calls the vendor", async () => {
    const status = await makeProvider().getOrder({ ...ORDER_REF, paymentRequest: null })

    expect(status).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect((status as Error).message).toBe("status lookup requires payment request")
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })
})

describe("bitcoinCompany registration", () => {
  it("registered itself on import and stays registered exactly once", () => {
    const registered = getRegisteredGiftCardProvider("bitcoinCompany")
    expect(registered).toBeDefined()
    expect(registered?.id).toBe("bitcoinCompany")

    registerBitcoinCompanyProvider()
    registerBitcoinCompanyProvider()

    expect(getRegisteredGiftCardProvider("bitcoinCompany")).toBe(registered)
  })

  it("re-registers after the registry is reset", () => {
    __resetGiftCardProvidersForTest()
    expect(getRegisteredGiftCardProvider("bitcoinCompany")).toBeUndefined()

    registerBitcoinCompanyProvider()

    expect(getRegisteredGiftCardProvider("bitcoinCompany")?.id).toBe("bitcoinCompany")
  })
})
