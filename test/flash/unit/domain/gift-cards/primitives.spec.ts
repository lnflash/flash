import {
  GIFT_CARD_MAX_QUANTITY,
  GiftCardInvalidValueError,
  checkedGiftCardQuantity,
  checkedGiftCardValue,
} from "@domain/gift-cards"

const fixedProduct = (over: Partial<GiftCardProduct> = {}): GiftCardProduct => ({
  id: "bitcoinCompany:fixed" as GiftCardProductId,
  providerId: "bitcoinCompany",
  providerProductId: "fixed",
  name: "Fixed Card",
  brand: "Fixed",
  countryCode: "US",
  currency: "USD",
  denominationType: "fixed",
  denominations: [1000, 2500, 5000],
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

const variableProduct = (over: Partial<GiftCardProduct> = {}): GiftCardProduct =>
  fixedProduct({
    id: "bitcoinCompany:variable" as GiftCardProductId,
    providerProductId: "variable",
    denominationType: "variable",
    denominations: [],
    minValue: 500,
    maxValue: 50_000,
    ...over,
  })

const messageOf = (result: number | GiftCardInvalidValueError): string =>
  result instanceof Error ? result.message : `ok:${result}`

describe("checkedGiftCardQuantity", () => {
  it("caps Flash-wide at 10", () => {
    expect(GIFT_CARD_MAX_QUANTITY).toBe(10)
  })

  it.each<[number, number]>([
    // [quantity, product.maxQuantity]
    [1, 1],
    [1, 10],
    [10, 10],
    [3, 3],
    // Vendor cap above Flash's ceiling: Flash's ceiling is what is allowed.
    [10, 50],
    // A malformed vendor cap is treated as single-card, never trusted upward.
    [1, 0],
    [1, -5],
    [1, 2.5],
    [1, Number.NaN],
  ])("accepts quantity %p with maxQuantity %p", (quantity, maxQuantity) => {
    expect(checkedGiftCardQuantity(quantity, maxQuantity)).toBe(quantity)
  })

  it.each<[number, number, string]>([
    // [quantity, product.maxQuantity, error message]
    [2, 1, "This card can only be bought one at a time"],
    [11, 10, "Quantity must be between 1 and 10"],
    [4, 3, "Quantity must be between 1 and 3"],
    // Vendor cap above Flash's ceiling: Flash's ceiling wins.
    [11, 50, "Quantity must be between 1 and 10"],
    // Below 1, fractional, or not a number: never valid.
    [0, 10, "Quantity must be between 1 and 10"],
    [-1, 10, "Quantity must be between 1 and 10"],
    [1.5, 10, "Quantity must be between 1 and 10"],
    [Number.NaN, 10, "Quantity must be between 1 and 10"],
    [Number.POSITIVE_INFINITY, 10, "Quantity must be between 1 and 10"],
    // A malformed vendor cap is treated as single-card, never trusted upward.
    [2, 0, "This card can only be bought one at a time"],
    [2, 2.5, "This card can only be bought one at a time"],
  ])("rejects quantity %p with maxQuantity %p: %p", (quantity, maxQuantity, message) => {
    const result = checkedGiftCardQuantity(quantity, maxQuantity)
    expect(result).toBeInstanceOf(GiftCardInvalidValueError)
    expect(messageOf(result)).toBe(message)
  })
})

describe("checkedGiftCardValue", () => {
  describe("whole-unit-only cards", () => {
    const whole = variableProduct({ wholeUnitsOnly: true })

    it.each([500, 1000, 2500, 50_000])(
      "accepts %p minor (a whole unit)",
      (valueMinor) => {
        expect(checkedGiftCardValue(whole, valueMinor)).toBe(valueMinor)
      },
    )

    it.each([1050, 1001, 1099, 2599])("rejects %p minor (has cents)", (valueMinor) => {
      const result = checkedGiftCardValue(whole, valueMinor)
      expect(result).toBeInstanceOf(GiftCardInvalidValueError)
      expect(messageOf(result)).toBe("This card only accepts whole-unit amounts")
    })

    it("still applies the range rules to whole-unit values", () => {
      expect(messageOf(checkedGiftCardValue(whole, 400))).toBe(
        "Gift card value is below the minimum for this card",
      )
      expect(messageOf(checkedGiftCardValue(whole, 50_100))).toBe(
        "Gift card value is above the maximum for this card",
      )
    })

    it("accepts cents on a card that is not whole-units-only", () => {
      expect(checkedGiftCardValue(variableProduct(), 1050)).toBe(1050)
      expect(checkedGiftCardValue(variableProduct(), 1001)).toBe(1001)
    })
  })

  describe("fixed denominations", () => {
    it("accepts a listed denomination", () => {
      expect(checkedGiftCardValue(fixedProduct(), 2500)).toBe(2500)
    })

    it("rejects a value that is not one of the denominations", () => {
      expect(messageOf(checkedGiftCardValue(fixedProduct(), 2000))).toBe(
        "Gift card value must be one of the listed denominations",
      )
    })

    it("rejects a denomination-shaped value with cents on a whole-units-only fixed card", () => {
      // Mappers set false for fixed cards; if one ever set true, cents are still refused.
      expect(
        messageOf(
          checkedGiftCardValue(
            fixedProduct({ denominations: [1050], wholeUnitsOnly: true }),
            1050,
          ),
        ),
      ).toBe("This card only accepts whole-unit amounts")
    })
  })

  describe("variable range", () => {
    it("accepts the bounds and anything between", () => {
      expect(checkedGiftCardValue(variableProduct(), 500)).toBe(500)
      expect(checkedGiftCardValue(variableProduct(), 12_345)).toBe(12_345)
      expect(checkedGiftCardValue(variableProduct(), 50_000)).toBe(50_000)
    })

    it("rejects below the minimum and above the maximum", () => {
      expect(messageOf(checkedGiftCardValue(variableProduct(), 499))).toBe(
        "Gift card value is below the minimum for this card",
      )
      expect(messageOf(checkedGiftCardValue(variableProduct(), 50_001))).toBe(
        "Gift card value is above the maximum for this card",
      )
    })

    it("treats a null bound as unbounded on that side", () => {
      expect(checkedGiftCardValue(variableProduct({ minValue: null }), 1)).toBe(1)
      expect(checkedGiftCardValue(variableProduct({ maxValue: null }), 10_000_000)).toBe(
        10_000_000,
      )
    })
  })

  it.each([0, -100, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %p before any product rule is consulted",
    (valueMinor) => {
      for (const product of [fixedProduct(), variableProduct({ wholeUnitsOnly: true })]) {
        expect(messageOf(checkedGiftCardValue(product, valueMinor))).toBe(
          "Gift card value must be a positive whole amount",
        )
      }
    },
  )
})
