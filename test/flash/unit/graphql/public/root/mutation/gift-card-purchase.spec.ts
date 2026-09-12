// jest.mock calls are hoisted before imports

const mockMasterGate = jest.fn()
const mockResolveCountry = jest.fn()
const mockPurchaseGiftCard = jest.fn()
const mockGetGiftCardOrderForAccount = jest.fn()
const mockConsumeLimiter = jest.fn()

jest.mock("@app/gift-cards", () => ({
  giftCardsMasterGate: (...a: unknown[]) => mockMasterGate(...a),
  resolveAccountCountryCodeOrUnknown: (...a: unknown[]) => mockResolveCountry(...a),
  purchaseGiftCard: (...a: unknown[]) => mockPurchaseGiftCard(...a),
  getGiftCardOrderForAccount: (...a: unknown[]) => mockGetGiftCardOrderForAccount(...a),
}))

jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (...a: unknown[]) => mockConsumeLimiter(...a),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { InvalidIdempotencyKeyError } from "@domain/errors"
import {
  GiftCardClaimCryptoError,
  GiftCardIdempotencyKeyReuseError,
  GiftCardInvalidValueError,
  GiftCardLevelNotEligibleError,
  GiftCardLimitExceededError,
  GiftCardOrderNotFoundError,
  GiftCardProductNotAvailableInCountryError,
  GiftCardProductNotFoundError,
  GiftCardProviderUnavailableError,
  GiftCardQuoteMismatchError,
  GiftCardsDisabledError,
  GiftCardVendorRejectedOrderError,
  GiftCardVendorUnavailableError,
  UnknownGiftCardError,
} from "@domain/gift-cards"
import { GiftCardPurchaseRateLimiterExceededError } from "@domain/rate-limit/errors"
import { InputValidationError } from "@graphql/error"
import GiftCardPurchaseMutation, {
  GIFT_CARD_IDEMPOTENCY_KEY_MAX_LENGTH,
  GIFT_CARD_IDEMPOTENCY_KEY_MIN_LENGTH,
} from "@graphql/public/root/mutation/gift-card-purchase"
import type { GiftCardOrderSource } from "@graphql/public/types/object/gift-card-order"

import { makeOrder, WALLET_ID } from "test/flash/unit/app/gift-cards/fixtures"

const ACCOUNT_ID = "account-001" as AccountId
const PRODUCT_ID = "bitcoinCompany:amazon-us"
const IDEMPOTENCY_KEY = "2f1c9c1e-4b7d-4a10-9f33-6c8e2d4b7a51"

const ctx = {
  domainAccount: { id: ACCOUNT_ID, kratosUserId: "kratos-1", level: 1 },
} as unknown as GraphQLPublicContextAuth

const CLAIM: GiftCardClaim = {
  codes: [{ label: null, value: "ABCD-EFGH-1234" }],
  claimLink: null,
  barcode: null,
}

type PurchaseResult = {
  errors: Array<{ code?: string; message?: string }>
  order?: GiftCardOrderSource
}

const input = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT_ID,
  value: 2500,
  quantity: 1,
  walletId: WALLET_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  ...overrides,
})

const resolve = async (
  inputOverrides: Record<string, unknown> = {},
): Promise<PurchaseResult> => {
  const mutation = GiftCardPurchaseMutation as unknown as {
    resolve: (
      source: null,
      args: { input: Record<string, unknown> },
      context: GraphQLPublicContextAuth,
      info: never,
    ) => Promise<PurchaseResult>
  }
  return mutation.resolve(null, { input: input(inputOverrides) }, ctx, {} as never)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveCountry.mockResolvedValue("JM")
  mockMasterGate.mockReturnValue({ ok: true, providerId: "bitcoinCompany" })
  mockPurchaseGiftCard.mockResolvedValue(makeOrder({ status: "PAID" }))
  mockGetGiftCardOrderForAccount.mockResolvedValue({
    order: makeOrder({ status: "FULFILLED" }),
    claim: CLAIM,
    claimError: null,
  })
  mockConsumeLimiter.mockResolvedValue(true)
})

describe("giftCardPurchase resolver", () => {
  describe("argument validation (before the gate, before any purchase)", () => {
    it("returns the CentAmount scalar's error for a bad value", async () => {
      const result = await resolve({
        value: new InputValidationError({ message: "Invalid value for CentAmount" }),
      })

      expect(result.errors).toEqual([{ message: "Invalid value for CentAmount" }])
      expect(result.order).toBeUndefined()
      expect(mockMasterGate).not.toHaveBeenCalled()
      expect(mockPurchaseGiftCard).not.toHaveBeenCalled()
    })

    it("returns the WalletId scalar's error for a bad wallet id", async () => {
      const result = await resolve({
        walletId: new InputValidationError({ message: "Invalid value for WalletId" }),
      })

      expect(result.errors).toEqual([{ message: "Invalid value for WalletId" }])
      expect(mockPurchaseGiftCard).not.toHaveBeenCalled()
    })

    describe("idempotencyKey", () => {
      const isRefusal = (result: PurchaseResult) =>
        result.errors.length === 1 &&
        (result.errors[0].message ?? "").includes("idempotencyKey") &&
        result.order === undefined

      it("refuses a key shorter than the minimum", async () => {
        const result = await resolve({
          idempotencyKey: "x".repeat(GIFT_CARD_IDEMPOTENCY_KEY_MIN_LENGTH - 1),
        })

        expect(isRefusal(result)).toBe(true)
        expect(mockPurchaseGiftCard).not.toHaveBeenCalled()
      })

      it("refuses a key longer than the maximum", async () => {
        const result = await resolve({
          idempotencyKey: "x".repeat(GIFT_CARD_IDEMPOTENCY_KEY_MAX_LENGTH + 1),
        })

        expect(isRefusal(result)).toBe(true)
        expect(mockPurchaseGiftCard).not.toHaveBeenCalled()
      })

      it("refuses a key containing whitespace", async () => {
        // The app layer trims, so "        " would reach it as "" and come back
        // as a confusing UUID-format error. Refuse it plainly here.
        expect(isRefusal(await resolve({ idempotencyKey: "        " }))).toBe(true)
        expect(isRefusal(await resolve({ idempotencyKey: "abcd efgh" }))).toBe(true)
        expect(mockPurchaseGiftCard).not.toHaveBeenCalled()
      })

      it("accepts both boundary lengths", async () => {
        await resolve({
          idempotencyKey: "x".repeat(GIFT_CARD_IDEMPOTENCY_KEY_MIN_LENGTH),
        })
        await resolve({
          idempotencyKey: "x".repeat(GIFT_CARD_IDEMPOTENCY_KEY_MAX_LENGTH),
        })

        expect(mockPurchaseGiftCard).toHaveBeenCalledTimes(2)
      })

      it("pins the documented bounds", () => {
        expect(GIFT_CARD_IDEMPOTENCY_KEY_MIN_LENGTH).toBe(8)
        expect(GIFT_CARD_IDEMPOTENCY_KEY_MAX_LENGTH).toBe(64)
      })
    })
  })

  describe("master gate", () => {
    it("returns GIFT_CARDS_DISABLED in the payload when the rail is off, without purchasing", async () => {
      mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })

      const result = await resolve()

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].code).toBe("GIFT_CARDS_DISABLED")
      expect(result.order).toBeUndefined()
      expect(mockPurchaseGiftCard).not.toHaveBeenCalled()
    })

    it("gates on the calling account's country", async () => {
      await resolve()

      expect(mockResolveCountry).toHaveBeenCalledWith(ctx.domainAccount)
      expect(mockMasterGate).toHaveBeenCalledWith("JM")
    })

    it("returns GIFT_CARD_PROVIDER_UNAVAILABLE when no provider serves the country", async () => {
      mockMasterGate.mockReturnValue({
        ok: false,
        error: new GiftCardProviderUnavailableError(),
      })

      const result = await resolve()

      expect(result.errors[0].code).toBe("GIFT_CARD_PROVIDER_UNAVAILABLE")
    })
  })

  describe("the purchase call", () => {
    it("passes every input through, with the account from the session and the value as minor units", async () => {
      await resolve({ quantity: 3 })

      expect(mockPurchaseGiftCard).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        walletId: WALLET_ID,
        productId: PRODUCT_ID,
        valueMinor: 2500,
        quantity: 3,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
    })

    it("passes the idempotencyKey through UNCHANGED", async () => {
      // The replay guarantee hangs on the key reaching the store exactly as the
      // client will send it again. Any normalisation here would make a retry
      // with the same key look like a new purchase.
      const key = "ULID-01J7M4QZ8X-mixedCase_and.dots"
      await resolve({ idempotencyKey: key })

      expect(mockPurchaseGiftCard).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: key }),
      )
    })

    it("defaults quantity to 1 when the input omits it", async () => {
      await resolve({ quantity: undefined })
      expect(mockPurchaseGiftCard).toHaveBeenLastCalledWith(
        expect.objectContaining({ quantity: 1 }),
      )

      await resolve({ quantity: null })
      expect(mockPurchaseGiftCard).toHaveBeenLastCalledWith(
        expect.objectContaining({ quantity: 1 }),
      )
    })

    it("does NOT consume the purchase rate limiter itself — purchaseGiftCard does", async () => {
      await resolve()

      expect(mockConsumeLimiter).not.toHaveBeenCalled()
    })
  })

  describe("error mapping", () => {
    // Every ApplicationError the use case can return, and the code the client
    // must see for it. A new error class that is not in the error map would
    // throw `assertUnreachable` here instead of reaching the customer as a 500.
    const CASES: Array<[string, Error, string]> = [
      ["disabled", new GiftCardsDisabledError(), "GIFT_CARDS_DISABLED"],
      [
        "provider unavailable",
        new GiftCardProviderUnavailableError(),
        "GIFT_CARD_PROVIDER_UNAVAILABLE",
      ],
      [
        "product not found",
        new GiftCardProductNotFoundError(),
        "GIFT_CARD_PRODUCT_NOT_FOUND",
      ],
      [
        "not available in country",
        new GiftCardProductNotAvailableInCountryError(),
        "GIFT_CARD_PRODUCT_NOT_AVAILABLE_IN_COUNTRY",
      ],
      ["invalid value", new GiftCardInvalidValueError(), "GIFT_CARD_INVALID_VALUE"],
      ["limit exceeded", new GiftCardLimitExceededError(), "GIFT_CARD_LIMIT_EXCEEDED"],
      [
        "level not eligible",
        new GiftCardLevelNotEligibleError(),
        "GIFT_CARD_LEVEL_NOT_ELIGIBLE",
      ],
      ["quote mismatch", new GiftCardQuoteMismatchError(), "GIFT_CARD_QUOTE_MISMATCH"],
      [
        "vendor rejected",
        new GiftCardVendorRejectedOrderError(),
        "GIFT_CARD_VENDOR_REJECTED",
      ],
      [
        "vendor unavailable",
        new GiftCardVendorUnavailableError(),
        "GIFT_CARD_VENDOR_UNAVAILABLE",
      ],
      [
        "idempotency key reuse",
        new GiftCardIdempotencyKeyReuseError(),
        "GIFT_CARD_IDEMPOTENCY_KEY_REUSE",
      ],
      [
        "rate limited",
        new GiftCardPurchaseRateLimiterExceededError(),
        "GIFT_CARD_PURCHASE_RATE_LIMITED",
      ],
      ["unknown", new UnknownGiftCardError(), "GIFT_CARD_UNKNOWN"],
      [
        "bad idempotency key (app layer)",
        new InvalidIdempotencyKeyError(),
        "INVALID_INPUT",
      ],
    ]

    it.each(CASES)("maps %s into the payload", async (_label, error, code) => {
      mockPurchaseGiftCard.mockResolvedValue(error)

      const result = await resolve()

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].code).toBe(code)
      expect(result.order).toBeUndefined()
      expect(mockGetGiftCardOrderForAccount).not.toHaveBeenCalled()
    })

    it("relays the use case's message so the client shows the wording it chose", async () => {
      mockPurchaseGiftCard.mockResolvedValue(
        new GiftCardQuoteMismatchError("The gift card price changed; please try again"),
      )

      const result = await resolve()

      expect(result.errors[0].message).toBe(
        "The gift card price changed; please try again",
      )
    })
  })

  describe("success", () => {
    it("returns the order, without a claim, while it is still in flight", async () => {
      const order = makeOrder({ status: "PAYMENT_PENDING" })
      mockPurchaseGiftCard.mockResolvedValue(order)

      const result = await resolve()

      expect(result.errors).toEqual([])
      expect(result.order).toMatchObject({
        id: order.id,
        status: "PAYMENT_PENDING",
        value: 2500,
        currency: "USD",
        quantity: 1,
        claim: null,
      })
      // No claim to read yet — the owner-scoped read is not even attempted.
      expect(mockGetGiftCardOrderForAccount).not.toHaveBeenCalled()
    })

    it("returns a replayed order as-is (same key, same parameters)", async () => {
      // purchaseGiftCard hands back the existing order for a replay; the
      // mutation must not treat that as anything other than success.
      mockPurchaseGiftCard.mockResolvedValue(makeOrder({ status: "EXPIRED" }))

      const result = await resolve()

      expect(result.errors).toEqual([])
      expect(result.order?.status).toBe("EXPIRED")
    })

    it("attaches the claim when the order is already FULFILLED, via the owner-scoped read", async () => {
      const order = makeOrder({
        status: "FULFILLED",
        claimCiphertext: "enc:...",
        claimKeyId: "k1",
      })
      mockPurchaseGiftCard.mockResolvedValue(order)

      const result = await resolve()

      expect(mockGetGiftCardOrderForAccount).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        orderId: order.id,
      })
      expect(result.errors).toEqual([])
      expect(result.order?.status).toBe("FULFILLED")
      expect(result.order?.claim).toEqual(CLAIM)
    })

    it("still returns a FULFILLED order when its claim cannot be read — with the error alongside", async () => {
      // The card IS issued; hiding the order would tell the customer nothing
      // happened. But a FULFILLED order with a silently empty claim is worse, so
      // the read failure rides along in `errors`. The owner-scoped read hands
      // the decrypt failure back as data (`claimError`), not as its own error.
      const order = makeOrder({
        status: "FULFILLED",
        claimCiphertext: "enc:...",
        claimKeyId: "k1",
      })
      mockPurchaseGiftCard.mockResolvedValue(order)
      mockGetGiftCardOrderForAccount.mockResolvedValue({
        order,
        claim: null,
        claimError: new GiftCardClaimCryptoError("key rotated"),
      })

      const result = await resolve()

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].code).toBe("GIFT_CARD_CLAIM_UNAVAILABLE")
      expect(result.order?.status).toBe("FULFILLED")
      expect(result.order?.claim).toBeNull()
    })

    it("still returns a FULFILLED order when the owner-scoped read itself fails — with the error alongside", async () => {
      // Distinct from a decrypt failure: here the read could not produce the
      // order at all (store fault, row gone between write and read). The order
      // the purchase already returned is still handed back.
      const order = makeOrder({ status: "FULFILLED" })
      mockPurchaseGiftCard.mockResolvedValue(order)
      mockGetGiftCardOrderForAccount.mockResolvedValue(new GiftCardOrderNotFoundError())

      const result = await resolve()

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].code).toBe("GIFT_CARD_ORDER_NOT_FOUND")
      expect(result.order?.id).toBe(order.id)
      expect(result.order?.status).toBe("FULFILLED")
      expect(result.order?.claim).toBeNull()
    })

    it("never carries the ciphertext or key id onto the payload", async () => {
      mockPurchaseGiftCard.mockResolvedValue(
        makeOrder({
          status: "FULFILLED",
          claimCiphertext: "enc:should-never-leave",
          claimKeyId: "k1",
        }),
      )

      const result = await resolve()

      expect(result.order).not.toHaveProperty("claimCiphertext")
      expect(result.order).not.toHaveProperty("claimKeyId")
      expect(JSON.stringify(result)).not.toContain("should-never-leave")
    })
  })
})
