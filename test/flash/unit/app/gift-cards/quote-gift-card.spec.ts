import { CouldNotFindAccountFromIdError } from "@domain/errors"
import {
  GiftCardInvalidValueError,
  GiftCardProductNotAvailableInCountryError,
  GiftCardProductNotFoundError,
  GiftCardProviderUnavailableError,
  GiftCardsDisabledError,
  GiftCardVendorUnavailableError,
} from "@domain/gift-cards"
import { GiftCardQuoteRateLimiterExceededError } from "@domain/rate-limit/errors"

import { quoteGiftCard } from "@app/gift-cards/quote-gift-card"

import { ACCOUNT_ID, makeAccount, makeProduct } from "./fixtures"

const mockFindAccountById = jest.fn()
const mockMasterGate = jest.fn()
const mockResolveCountry = jest.fn()
const mockGetGiftCardProduct = jest.fn()
const mockGetProvider = jest.fn()
const mockQuote = jest.fn()
const mockConsumeLimiter = jest.fn()
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findById: (...a: unknown[]) => mockFindAccountById(...a),
  }),
}))
jest.mock("@app/gift-cards/gift-cards-master-gate", () => ({
  giftCardsMasterGate: (...a: unknown[]) => mockMasterGate(...a),
  resolveAccountCountryCodeOrUnknown: (...a: unknown[]) => mockResolveCountry(...a),
}))
jest.mock("@app/gift-cards/list-products", () => ({
  getGiftCardProduct: (...a: unknown[]) => mockGetGiftCardProduct(...a),
}))
jest.mock("@services/gift-cards/registry", () => ({
  getEnabledGiftCardProvider: (...a: unknown[]) => mockGetProvider(...a),
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))
jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (...a: unknown[]) => mockConsumeLimiter(...a),
}))
jest.mock("@domain/rate-limit", () => ({
  RateLimitConfig: { giftCardQuote: { key: "gift_card_quote" } },
}))
jest.mock("@services/logger", () => ({
  baseLogger: {
    info: (...a: unknown[]) => mockLogger.info(...a),
    warn: (...a: unknown[]) => mockLogger.warn(...a),
    error: (...a: unknown[]) => mockLogger.error(...a),
  },
}))

const PRODUCT = makeProduct() // variable, 500..50_000 minor, bitcoinCompany
const QUOTE: GiftCardQuote = {
  productId: PRODUCT.id,
  valueMinor: 2500,
  currency: "USD",
  quantity: 1,
  fiatCostMinor: 2500,
  satsCost: 40_000 as Satoshis,
  rewardSats: 400 as Satoshis,
  bitcoinPriceMinor: 6_250_000,
  expiresAt: new Date("2026-09-10T12:00:00Z"),
}

const quote = (overrides: Record<string, unknown> = {}) =>
  quoteGiftCard({
    accountId: ACCOUNT_ID,
    productId: PRODUCT.id,
    valueMinor: 2500,
    quantity: 1,
    ...overrides,
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockConsumeLimiter.mockResolvedValue(true)
  mockFindAccountById.mockResolvedValue(makeAccount())
  mockResolveCountry.mockResolvedValue("US")
  mockMasterGate.mockReturnValue({ ok: true, providerId: "bitcoinCompany" })
  mockGetGiftCardProduct.mockResolvedValue(PRODUCT)
  mockGetProvider.mockReturnValue({ id: "bitcoinCompany", quote: mockQuote })
  mockQuote.mockResolvedValue(QUOTE)
})

describe("quoteGiftCard", () => {
  // Every call past the budget is a live POST to the vendor through the ONE
  // shared reseller login every purchase also needs. The budget is charged
  // first, on the ACCOUNT, and counts attempts — refused ones included — so a
  // client looping on this field bounds its own cost, not every customer's.
  describe("attempt budget", () => {
    it("charges the per-account quote budget before any store or vendor call", async () => {
      await quote()

      expect(mockConsumeLimiter).toHaveBeenCalledTimes(1)
      expect(mockConsumeLimiter).toHaveBeenCalledWith({
        rateLimitConfig: { key: "gift_card_quote" },
        keyToConsume: ACCOUNT_ID,
      })
      const limiterOrder = mockConsumeLimiter.mock.invocationCallOrder[0]
      expect(limiterOrder).toBeLessThan(mockFindAccountById.mock.invocationCallOrder[0])
      expect(limiterOrder).toBeLessThan(mockQuote.mock.invocationCallOrder[0])
    })

    it("returns the limiter's refusal without reading the account or calling the vendor", async () => {
      mockConsumeLimiter.mockResolvedValue(new GiftCardQuoteRateLimiterExceededError())

      const result = await quote()

      expect(result).toBeInstanceOf(GiftCardQuoteRateLimiterExceededError)
      expect(mockFindAccountById).not.toHaveBeenCalled()
      expect(mockGetGiftCardProduct).not.toHaveBeenCalled()
      expect(mockQuote).not.toHaveBeenCalled()
    })

    it("falls through on a limiter STORE fault, warning rather than refusing", async () => {
      // `consumeLimiter` hands back UnknownRateLimitServiceError (not the
      // exceeded error) when Redis itself fails. Refusing every quote during a
      // store blip would page nobody and block everyone; the same posture as
      // purchaseGiftCard.
      mockConsumeLimiter.mockResolvedValue(new Error("redis down"))

      const result = await quote()

      expect(result).toBe(QUOTE)
      expect(mockQuote).toHaveBeenCalledTimes(1)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ACCOUNT_ID, error: "Error" }),
        expect.stringContaining("rate limiter unavailable"),
      )
    })

    it("counts a refused attempt against the budget too", async () => {
      mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })

      await quote()

      expect(mockConsumeLimiter).toHaveBeenCalledTimes(1)
    })
  })

  it("returns the vendor's quote for the checked value and quantity", async () => {
    const result = await quote({ valueMinor: 2500, quantity: 2 })

    expect(result).toBe(QUOTE)
    expect(mockGetProvider).toHaveBeenCalledWith("bitcoinCompany")
    expect(mockQuote).toHaveBeenCalledWith({
      product: PRODUCT,
      valueMinor: 2500,
      quantity: 2,
    })
  })

  it("gates on the ACCOUNT's routing country, resolved from the account it loaded", async () => {
    const account = makeAccount()
    mockFindAccountById.mockResolvedValue(account)
    mockResolveCountry.mockResolvedValue("JM")

    await quote()

    expect(mockFindAccountById).toHaveBeenCalledWith(ACCOUNT_ID)
    expect(mockResolveCountry).toHaveBeenCalledWith(account)
    expect(mockMasterGate).toHaveBeenCalledWith("JM")
  })

  it("propagates an account lookup failure before touching the catalog", async () => {
    mockFindAccountById.mockResolvedValue(new CouldNotFindAccountFromIdError())

    const result = await quote()

    expect(result).toBeInstanceOf(CouldNotFindAccountFromIdError)
    expect(mockGetGiftCardProduct).not.toHaveBeenCalled()
  })

  it("returns the gate's error when the rail is closed, without reading the catalog", async () => {
    mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })

    const result = await quote()

    expect(result).toBeInstanceOf(GiftCardsDisabledError)
    expect(mockGetGiftCardProduct).not.toHaveBeenCalled()
    expect(mockQuote).not.toHaveBeenCalled()
  })

  it("propagates a product lookup failure", async () => {
    mockGetGiftCardProduct.mockResolvedValue(new GiftCardProductNotFoundError())

    expect(await quote()).toBeInstanceOf(GiftCardProductNotFoundError)
    expect(mockQuote).not.toHaveBeenCalled()
  })

  it("refuses a product from a provider the account's country is not routed to", async () => {
    // The exact refusal purchaseGiftCard gives, so the quote cannot price a card
    // the purchase would then decline.
    mockGetGiftCardProduct.mockResolvedValue(makeProduct({ providerId: "bitrefill" }))

    expect(await quote()).toBeInstanceOf(GiftCardProductNotAvailableInCountryError)
    expect(mockQuote).not.toHaveBeenCalled()
  })

  it("refuses a sold-out product as not found", async () => {
    mockGetGiftCardProduct.mockResolvedValue(makeProduct({ inStock: false }))

    expect(await quote()).toBeInstanceOf(GiftCardProductNotFoundError)
    expect(mockQuote).not.toHaveBeenCalled()
  })

  describe("value and quantity validation", () => {
    it("refuses a value below the card's minimum", async () => {
      expect(await quote({ valueMinor: 499 })).toBeInstanceOf(GiftCardInvalidValueError)
      expect(mockQuote).not.toHaveBeenCalled()
    })

    it("refuses a value above the card's maximum", async () => {
      expect(await quote({ valueMinor: 50_001 })).toBeInstanceOf(
        GiftCardInvalidValueError,
      )
    })

    it("refuses an off-denomination value on a FIXED card", async () => {
      mockGetGiftCardProduct.mockResolvedValue(
        makeProduct({
          denominationType: "fixed",
          denominations: [1000, 2500],
          minValue: null,
          maxValue: null,
        }),
      )

      expect(await quote({ valueMinor: 2000 })).toBeInstanceOf(GiftCardInvalidValueError)
      expect(await quote({ valueMinor: 2500 })).toBe(QUOTE)
    })

    it("refuses a non-integer or non-positive value", async () => {
      expect(await quote({ valueMinor: 25.5 })).toBeInstanceOf(GiftCardInvalidValueError)
      expect(await quote({ valueMinor: 0 })).toBeInstanceOf(GiftCardInvalidValueError)
    })

    it("refuses a quantity outside 1..10", async () => {
      expect(await quote({ quantity: 0 })).toBeInstanceOf(GiftCardInvalidValueError)
      expect(await quote({ quantity: 11 })).toBeInstanceOf(GiftCardInvalidValueError)
      expect(mockQuote).not.toHaveBeenCalled()
    })
  })

  it("returns the registry's refusal when the gated provider is not enabled", async () => {
    mockGetProvider.mockReturnValue(new GiftCardProviderUnavailableError())

    expect(await quote()).toBeInstanceOf(GiftCardProviderUnavailableError)
    expect(mockQuote).not.toHaveBeenCalled()
  })

  it("propagates the vendor's quote failure", async () => {
    mockQuote.mockResolvedValue(new GiftCardVendorUnavailableError())

    expect(await quote()).toBeInstanceOf(GiftCardVendorUnavailableError)
  })
})
