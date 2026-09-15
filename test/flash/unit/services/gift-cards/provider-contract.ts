/* eslint-disable jest/no-export -- shared contract suite, imported and invoked by each adapter spec */
import {
  GiftCardError,
  buildGiftCardProductId,
  checkedGiftCardValue,
  parseGiftCardProductId,
  toGiftCardProviderOrderId,
} from "@domain/gift-cards"

/**
 * Shared behavioural contract for every `IGiftCardProvider` adapter. Each
 * adapter's spec mocks its own HTTP layer, then calls
 * `runGiftCardProviderContract` so the port semantics are asserted the same
 * way for Bitcoin Company, Bitrefill, and whatever comes next.
 */

export type GiftCardProviderContractFixtures = {
  providerId: GiftCardProviderId
  /** Wire the adapter's transport mocks so every port operation succeeds. Runs before each test. */
  arrangeHappyPath: () => void | Promise<void>
  /** Wire the adapter's transport mocks so the vendor is unreachable. Enables the failure test. */
  arrangeVendorDown?: () => void | Promise<void>
  /** Choose what to quote and order from the adapter's own listed catalog. */
  pickPurchase: (products: GiftCardProduct[]) => {
    product: GiftCardProduct
    valueMinor: number
    quantity: number
  }
  /** The Flash order id the adapter forwards to the vendor as a label. */
  reference: GiftCardOrderId
  /** Clock the adapter was built with, so expiry assertions line up. */
  now?: () => Date
  /** Set when the adapter cannot look up status without the payment request. */
  statusRequiresPaymentRequest?: boolean
}

const STATUS_KINDS: readonly GiftCardProviderOrderStatus["kind"][] = [
  "awaitingPayment",
  "paidPendingFulfillment",
  "fulfilled",
  "failed",
  "refunded",
]

const unwrap = <T>(value: T | Error): T => {
  if (value instanceof Error) throw value
  return value
}

const isNullOrSafeInt = (value: number | null): boolean =>
  value === null || Number.isSafeInteger(value)

const contractProduct = (providerId: GiftCardProviderId): GiftCardProduct => ({
  id: buildGiftCardProductId(providerId, "contract-product"),
  providerId,
  providerProductId: "contract-product",
  name: "Contract Test Card",
  brand: "Contract",
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
})

export const runGiftCardProviderContract = (
  name: string,
  makeProvider: () => IGiftCardProvider,
  fixtures: GiftCardProviderContractFixtures,
): void => {
  describe(`${name} satisfies the IGiftCardProvider contract`, () => {
    let provider: IGiftCardProvider
    const now = () => (fixtures.now ?? (() => new Date()))()

    beforeEach(async () => {
      await fixtures.arrangeHappyPath()
      provider = makeProvider()
    })

    it("reports the provider id it registers under", () => {
      expect(provider.id).toBe(fixtures.providerId)
    })

    it("listProducts returns normalised products with parseable ids", async () => {
      const products = unwrap(await provider.listProducts())
      expect(products.length).toBeGreaterThan(0)

      for (const product of products) {
        expect(product.providerId).toBe(fixtures.providerId)
        expect(product.id).toBe(
          buildGiftCardProductId(fixtures.providerId, product.providerProductId),
        )
        expect(parseGiftCardProductId(product.id)).toEqual({
          providerId: fixtures.providerId,
          providerProductId: product.providerProductId,
        })
        expect(product.countryCode).toMatch(/^[A-Z]{2}$/)
        expect(product.currency).toMatch(/^[A-Z]{3}$/)
        expect(product.name.trim()).not.toBe("")
        expect(product.brand.trim()).not.toBe("")
        expect(Number.isInteger(product.rewardBps) && product.rewardBps >= 0).toBe(true)
        expect(product.termsUrl === null || typeof product.termsUrl === "string").toBe(
          true,
        )
        expect(product.logoUrl === null || typeof product.logoUrl === "string").toBe(true)

        const denominationsOk =
          product.denominationType === "fixed"
            ? product.denominations.length > 0 &&
              product.denominations.every((d) => Number.isSafeInteger(d) && d > 0) &&
              product.minValue === null &&
              product.maxValue === null
            : product.denominations.length === 0 &&
              isNullOrSafeInt(product.minValue) &&
              isNullOrSafeInt(product.maxValue) &&
              (product.minValue === null ||
                product.maxValue === null ||
                product.minValue <= product.maxValue)
        expect({ id: product.id, denominationsOk }).toEqual({
          id: product.id,
          denominationsOk: true,
        })
      }
    })

    it("quotes, creates, and reads back an order for a product from its own catalog", async () => {
      const products = unwrap(await provider.listProducts())
      const { product, valueMinor, quantity } = fixtures.pickPurchase(products)
      expect(checkedGiftCardValue(product, valueMinor)).toBe(valueMinor)

      const quote = unwrap(await provider.quote({ product, valueMinor, quantity }))
      expect(quote.productId).toBe(product.id)
      expect(quote.valueMinor).toBe(valueMinor)
      expect(quote.currency).toBe(product.currency)
      expect(quote.quantity).toBe(quantity)
      expect(Number.isSafeInteger(quote.fiatCostMinor) && quote.fiatCostMinor > 0).toBe(
        true,
      )
      expect(Number.isSafeInteger(quote.satsCost) && quote.satsCost > 0).toBe(true)
      expect(Number.isSafeInteger(quote.rewardSats) && quote.rewardSats >= 0).toBe(true)
      expect(isNullOrSafeInt(quote.bitcoinPriceMinor)).toBe(true)
      expect(quote.expiresAt.getTime()).toBeGreaterThan(now().getTime())

      const order = unwrap(
        await provider.createOrder({
          product,
          valueMinor,
          quantity,
          reference: fixtures.reference,
        }),
      )
      expect(typeof order.providerOrderId).toBe("string")
      expect(order.providerOrderId).not.toBe("")
      expect(order.paymentRequest).not.toBe("")
      expect(Number.isSafeInteger(order.amountSats) && order.amountSats > 0).toBe(true)
      // Null when the vendor states no order expiry (the BOLT11 carries its own);
      // when stated, it must be in the future.
      expect(
        order.expiresAt === null || order.expiresAt.getTime() > now().getTime(),
      ).toBe(true)

      const status = unwrap(
        await provider.getOrder({
          providerOrderId: order.providerOrderId,
          paymentRequest: order.paymentRequest,
        }),
      )
      expect(STATUS_KINDS).toContain(status.kind)
      const redeemable =
        status.kind !== "fulfilled" ||
        status.claim.codes.length > 0 ||
        status.claim.claimLink !== null
      expect(redeemable).toBe(true)
    })

    if (fixtures.statusRequiresPaymentRequest) {
      it("getOrder without a payment request returns an error rather than throwing", async () => {
        const result = await provider.getOrder({
          providerOrderId: toGiftCardProviderOrderId("contract-order"),
          paymentRequest: null,
        })
        expect(result).toBeInstanceOf(GiftCardError)
      })
    }

    if (fixtures.arrangeVendorDown) {
      const arrangeVendorDown = fixtures.arrangeVendorDown
      it("returns GiftCardError values instead of throwing when the vendor is unreachable", async () => {
        await arrangeVendorDown()
        const product = contractProduct(fixtures.providerId)

        expect(await provider.listProducts()).toBeInstanceOf(GiftCardError)
        expect(
          await provider.quote({ product, valueMinor: 2500, quantity: 1 }),
        ).toBeInstanceOf(GiftCardError)
        expect(
          await provider.createOrder({
            product,
            valueMinor: 2500,
            quantity: 1,
            reference: fixtures.reference,
          }),
        ).toBeInstanceOf(GiftCardError)
        expect(
          await provider.getOrder({
            providerOrderId: toGiftCardProviderOrderId("contract-order"),
            paymentRequest: "lnbc1contract",
          }),
        ).toBeInstanceOf(GiftCardError)
      })
    }
  })
}
