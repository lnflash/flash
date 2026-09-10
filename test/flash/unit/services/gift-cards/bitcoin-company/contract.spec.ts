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
  GiftCardVendorUnavailableError,
  toGiftCardOrderId,
  toGiftCardProviderOrderId,
} from "@domain/gift-cards"
import {
  BitcoinCompanyProvider,
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
  QUOTE_RESULT,
  RouteHandler,
  callsTo,
  catalogPage,
  httpOk,
  networkError,
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

const happyPost: Record<string, RouteHandler> = {
  "/auth/login": () => httpOk(LOGIN_RESULT),
  "/svs/quote-card": () => httpOk(QUOTE_RESULT),
  "/giftcards/purchase/bitcoin": () => httpOk(PURCHASE_RESULT),
  "/giftcards/invoice-status": () => httpOk(FULFILLED_RESULT),
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

  it("maps the vendor catalog and skips rows without a country", async () => {
    const products = await makeProvider().listProducts()
    if (products instanceof Error) throw products

    expect(products.map((p) => p.id)).toEqual([
      "bitcoinCompany:prod-amazon-us",
      "bitcoinCompany:prod-visa-us",
    ])
    expect(mockedLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "listProducts",
        received: 3,
        mapped: 2,
        skipped: { "no-country": 1 },
      }),
      expect.any(String),
    )
  })

  it("sends major units, Lightning purchase type, and the order reference to the vendor", async () => {
    const provider = makeProvider()
    const products = await provider.listProducts()
    if (products instanceof Error) throw products
    const product = products[0]

    const quote = await provider.quote({ product, valueMinor: 2500, quantity: 2 })
    if (quote instanceof Error) throw quote
    const order = await provider.createOrder({
      product,
      valueMinor: 2500,
      quantity: 2,
      reference: REFERENCE,
    })
    if (order instanceof Error) throw order

    expect(callsTo(mockedAxios.post, "/svs/quote-card")[0][1]).toEqual({
      productId: "prod-amazon-us",
      cardValue: 25,
      quantity: 2,
      purchaseType: "Lightning",
    })
    expect(callsTo(mockedAxios.post, "/giftcards/purchase/bitcoin")[0][1]).toEqual({
      productId: "prod-amazon-us",
      cardValue: 25,
      quantity: 2,
      useUsdBalance: false,
      useSatsBalance: false,
      label: REFERENCE,
    })
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
      expiresAt: new Date(NOW + 15 * 60_000),
    })
  })

  it("maps a completed vendor order to fulfilled with its claim", async () => {
    const status = await makeProvider().getOrder({
      providerOrderId: toGiftCardProviderOrderId(PURCHASE_RESULT.uuid),
      paymentRequest: PURCHASE_RESULT.invoice,
    })

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

    const status = await makeProvider().getOrder({
      providerOrderId: toGiftCardProviderOrderId(PURCHASE_RESULT.uuid),
      paymentRequest: PURCHASE_RESULT.invoice,
    })

    expect(status).toEqual({ kind: "awaitingPayment" })
  })

  it("refuses a status lookup without a payment request and never calls the vendor", async () => {
    const status = await makeProvider().getOrder({
      providerOrderId: toGiftCardProviderOrderId(PURCHASE_RESULT.uuid),
      paymentRequest: null,
    })

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
