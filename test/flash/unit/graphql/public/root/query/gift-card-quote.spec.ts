// jest.mock calls are hoisted before imports

const mockMasterGate = jest.fn()
const mockResolveCountry = jest.fn()
const mockQuoteGiftCard = jest.fn()

jest.mock("@app/gift-cards", () => ({
  giftCardsMasterGate: (...a: unknown[]) => mockMasterGate(...a),
  resolveAccountCountryCodeOrUnknown: (...a: unknown[]) => mockResolveCountry(...a),
  quoteGiftCard: (...a: unknown[]) => mockQuoteGiftCard(...a),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  GiftCardInvalidValueError,
  GiftCardProductNotFoundError,
  GiftCardsDisabledError,
} from "@domain/gift-cards"
import { InputValidationError } from "@graphql/error"
import GiftCardQuoteQuery from "@graphql/public/root/query/gift-card-quote"
import type { GiftCardQuoteSource } from "@graphql/public/types/object/gift-card-quote"
import { MAXIMUM_QUERY_COMPLEXITY } from "@servers/plugins/complexity"

const ACCOUNT_ID = "account-001" as AccountId
const PRODUCT_ID = "bitcoinCompany:amazon-us"
const EXPIRES_AT = new Date("2026-09-10T12:00:00Z")

const ctx = {
  domainAccount: { id: ACCOUNT_ID, kratosUserId: "kratos-1", level: 1 },
} as unknown as GraphQLPublicContextAuth

const QUOTE: GiftCardQuote = {
  productId: PRODUCT_ID as GiftCardProductId,
  valueMinor: 2500,
  currency: "USD",
  quantity: 2,
  fiatCostMinor: 4900,
  satsCost: 80_000 as Satoshis,
  rewardSats: 800 as Satoshis,
  bitcoinPriceMinor: 6_250_000,
  expiresAt: EXPIRES_AT,
}

const resolve = async (args: Record<string, unknown>): Promise<GiftCardQuoteSource> => {
  const query = GiftCardQuoteQuery as unknown as {
    resolve: (
      source: null,
      args: Record<string, unknown>,
      context: GraphQLPublicContextAuth,
      info: never,
    ) => Promise<GiftCardQuoteSource>
  }
  return query.resolve(null, args, ctx, {} as never)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveCountry.mockResolvedValue("JM")
  mockMasterGate.mockReturnValue({ ok: true, providerId: "bitcoinCompany" })
  mockQuoteGiftCard.mockResolvedValue(QUOTE)
})

describe("giftCardQuote resolver", () => {
  describe("argument validation", () => {
    it("throws the CentAmount scalar's error without quoting", async () => {
      await expect(
        resolve({
          productId: PRODUCT_ID,
          value: new InputValidationError({ message: "Invalid value for CentAmount" }),
        }),
      ).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } })
      expect(mockMasterGate).not.toHaveBeenCalled()
      expect(mockQuoteGiftCard).not.toHaveBeenCalled()
    })

    it("refuses a zero or negative quantity before the gate", async () => {
      await expect(
        resolve({ productId: PRODUCT_ID, value: 2500, quantity: 0 }),
      ).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } })
      await expect(
        resolve({ productId: PRODUCT_ID, value: 2500, quantity: -1 }),
      ).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } })
      expect(mockQuoteGiftCard).not.toHaveBeenCalled()
    })

    it("defaults quantity to 1 when the argument is absent or null", async () => {
      await resolve({ productId: PRODUCT_ID, value: 2500 })
      expect(mockQuoteGiftCard).toHaveBeenLastCalledWith(
        expect.objectContaining({ quantity: 1 }),
      )

      await resolve({ productId: PRODUCT_ID, value: 2500, quantity: null })
      expect(mockQuoteGiftCard).toHaveBeenLastCalledWith(
        expect.objectContaining({ quantity: 1 }),
      )
    })

    it("leaves the upper quantity bound to the app layer (GIFT_CARD_INVALID_VALUE)", async () => {
      mockQuoteGiftCard.mockResolvedValue(
        new GiftCardInvalidValueError("Quantity must be between 1 and 10"),
      )

      await expect(
        resolve({ productId: PRODUCT_ID, value: 2500, quantity: 11 }),
      ).rejects.toMatchObject({
        extensions: { code: "GIFT_CARD_INVALID_VALUE" },
        message: "Quantity must be between 1 and 10",
      })
    })
  })

  it("throws GIFT_CARDS_DISABLED when the rail is off, without quoting", async () => {
    mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })

    await expect(resolve({ productId: PRODUCT_ID, value: 2500 })).rejects.toMatchObject({
      extensions: { code: "GIFT_CARDS_DISABLED" },
    })
    expect(mockResolveCountry).toHaveBeenCalledWith(ctx.domainAccount)
    expect(mockMasterGate).toHaveBeenCalledWith("JM")
    expect(mockQuoteGiftCard).not.toHaveBeenCalled()
  })

  it("quotes for THIS account, with the value as minor units", async () => {
    await resolve({ productId: PRODUCT_ID, value: 2500, quantity: 2 })

    // The account id comes from the session, never from an argument.
    expect(mockQuoteGiftCard).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      valueMinor: 2500,
      quantity: 2,
    })
  })

  it("maps the domain quote onto the wire names, one field each, dropping the vendor price", async () => {
    const result = await resolve({ productId: PRODUCT_ID, value: 2500, quantity: 2 })

    // Every source value is distinct so a swap between any two fields fails.
    expect(result).toEqual({
      productId: PRODUCT_ID,
      value: 2500,
      currency: "USD",
      quantity: 2,
      fiatCost: 4900,
      satsCost: 80_000,
      rewardSats: 800,
      expiresAt: EXPIRES_AT,
    })
    expect(result).not.toHaveProperty("bitcoinPriceMinor")
    expect(result).not.toHaveProperty("valueMinor")
    expect(result).not.toHaveProperty("fiatCostMinor")
  })

  it("hands expiresAt to the Timestamp scalar as a Date", async () => {
    const result = await resolve({ productId: PRODUCT_ID, value: 2500 })

    expect(result.expiresAt).toBeInstanceOf(Date)
  })

  it("throws the mapped app error when the quote is refused", async () => {
    mockQuoteGiftCard.mockResolvedValue(new GiftCardProductNotFoundError())

    await expect(resolve({ productId: PRODUCT_ID, value: 2500 })).rejects.toMatchObject({
      extensions: { code: "GIFT_CARD_PRODUCT_NOT_FOUND" },
    })
  })
})

// Every resolve of this field is a live POST to the vendor's quote endpoint
// through the ONE shared reseller login every purchase also needs, and ROOT
// QUERY FIELDS RESOLVE IN PARALLEL. Undeclared, `simpleEstimator({
// defaultComplexity: 1 })` scores it at 1 against the server's ceiling, so one
// authenticated document aliasing it 25 times fires 25 concurrent vendor
// POSTs. The 30/min per-account limiter is not an answer to that: it consumes
// once per RESOLVE, so it refuses the NEXT request, after the burst has landed.
describe("giftCardQuote is budgeted for the vendor call it performs", () => {
  const declared = () => {
    const complexity = GiftCardQuoteQuery.extensions?.complexity
    expect(typeof complexity).toBe("number")
    return complexity as number
  }

  it("declares a complexity rather than taking the default of 1", () => {
    expect(declared()).toBeGreaterThan(1)
  })

  it("costs enough that a second copy cannot fit in the same document", () => {
    // Against the ceiling the server actually enforces — IMPORTED, not
    // hand-copied — so raising the ceiling fails this rather than leaving it
    // green with the property gone. Once must fit; twice must not.
    expect(declared()).toBeLessThanOrEqual(MAXIMUM_QUERY_COMPLEXITY)
    expect(declared() * 2).toBeGreaterThan(MAXIMUM_QUERY_COMPLEXITY)
  })
})
