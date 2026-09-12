import { UnknownRepositoryError } from "@domain/errors"
import { GiftCardClaimCryptoError, GiftCardOrderNotFoundError } from "@domain/gift-cards"

const mockDecrypt = jest.fn()
const mockAddAttributes = jest.fn()

let repo: FakeOrdersRepo

jest.mock("@services/mongoose", () => ({
  GiftCardOrdersRepository: () => repo,
}))
jest.mock("@services/gift-cards/claim-crypto", () => ({
  decryptGiftCardClaim: (...a: unknown[]) => mockDecrypt(...a),
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: (...a: unknown[]) => mockAddAttributes(...a),
}))

import {
  getGiftCardOrderForAccount,
  type GiftCardOrderWithClaim,
} from "@app/gift-cards/get-order"

import {
  ACCOUNT_ID,
  allMockCallText,
  makeFakeOrdersRepo,
  makeOrder,
  NOW_MS,
  type FakeOrdersRepo,
} from "./fixtures"

const OTHER_ACCOUNT_ID = "6a8203ce490716aa69381499" as AccountId
const ORDER_ID = "order-1" as GiftCardOrderId
const CIPHERTEXT = "enc:CIPHERTEXT-MUST-NEVER-LEAK-4c1d"
const KEY_ID = "0123456789abcdef"
const CLAIM_CODE = "CLAIM-CODE-SECRET-9f8e7d"
const CLAIM: GiftCardClaim = {
  codes: [{ label: "Code", value: CLAIM_CODE }],
  claimLink: null,
  barcode: null,
}

const fulfilledOrder = (overrides: Partial<GiftCardOrder> = {}) =>
  repo.seed(
    makeOrder({
      status: "FULFILLED",
      claimCiphertext: CIPHERTEXT,
      claimKeyId: KEY_ID,
      fulfilledAt: new Date(NOW_MS),
      paidSats: 40_100 as Satoshis,
      ...overrides,
    }),
  )

const read = (accountId: AccountId = ACCOUNT_ID, orderId: GiftCardOrderId = ORDER_ID) =>
  getGiftCardOrderForAccount({ accountId, orderId })

/** Narrow a result to the data shape, failing loudly if it came back as an error. */
const ok = (
  result: GiftCardOrderWithClaim | ApplicationError,
): GiftCardOrderWithClaim => {
  if (result instanceof Error)
    throw new Error(`expected data, got ${result.constructor.name}`)
  return result
}

beforeEach(() => {
  jest.clearAllMocks()
  repo = makeFakeOrdersRepo()
  mockDecrypt.mockReturnValue(CLAIM)
})

describe("getGiftCardOrderForAccount", () => {
  describe("errors — only when the order itself cannot be read", () => {
    it("returns NotFound for an unknown id", async () => {
      const result = await read(ACCOUNT_ID, "no-such-order" as GiftCardOrderId)

      expect(result).toBeInstanceOf(GiftCardOrderNotFoundError)
      expect(mockDecrypt).not.toHaveBeenCalled()
    })

    it("returns NotFound for another account's order — indistinguishable from unknown — and never decrypts", async () => {
      fulfilledOrder()

      const result = await read(OTHER_ACCOUNT_ID)

      expect(result).toBeInstanceOf(GiftCardOrderNotFoundError)
      expect(mockDecrypt).not.toHaveBeenCalled()
      // Nothing about the order goes on the span for a caller who may not see it.
      expect(mockAddAttributes).not.toHaveBeenCalled()
    })

    it("passes a repository fault through as the error", async () => {
      const fault = new UnknownRepositoryError("mongo down")
      repo.findById.mockResolvedValueOnce(fault)

      expect(await read()).toBe(fault)
      expect(mockDecrypt).not.toHaveBeenCalled()
    })
  })

  describe("before FULFILLED", () => {
    it("returns the order with claim and claimError both null, without decrypting", async () => {
      repo.seed(makeOrder({ status: "PAID", paidSats: 40_100 as Satoshis }))

      const result = ok(await read())

      expect(result.order.id).toBe(ORDER_ID)
      expect(result.order.status).toBe("PAID")
      expect(result.claim).toBeNull()
      expect(result.claimError).toBeNull()
      expect(mockDecrypt).not.toHaveBeenCalled()
    })
  })

  describe("FULFILLED", () => {
    it("decrypts the stored claim under the stored key id, bound to this order's id, and returns it", async () => {
      fulfilledOrder()

      const result = ok(await read())

      expect(mockDecrypt).toHaveBeenCalledTimes(1)
      // The order id is authenticated data: a ciphertext copied from another
      // row will not open here.
      expect(mockDecrypt).toHaveBeenCalledWith({
        ciphertext: CIPHERTEXT,
        keyId: KEY_ID,
        orderId: ORDER_ID,
      })
      expect(result.order.status).toBe("FULFILLED")
      expect(result.claim).toEqual(CLAIM)
      expect(result.claimError).toBeNull()
    })

    it("does not decrypt a FULFILLED order that carries no ciphertext", async () => {
      fulfilledOrder({ claimCiphertext: null, claimKeyId: null })

      const result = ok(await read())

      expect(result.claim).toBeNull()
      expect(result.claimError).toBeNull()
      expect(mockDecrypt).not.toHaveBeenCalled()
    })

    it("returns the order with claim null and the crypto error as DATA when the claim will not decrypt", async () => {
      // A rotated key (or one pod on stale config) must not hide the order from
      // its owner: the card IS issued and paid for. Only "cannot read the order"
      // is an error; "cannot read its claim" rides back alongside the order so
      // each caller decides how to surface it.
      fulfilledOrder()
      const cryptoError = new GiftCardClaimCryptoError("key rotated")
      mockDecrypt.mockReturnValue(cryptoError)

      const result = await read()

      expect(result).not.toBeInstanceOf(Error)
      const data = ok(result)
      expect(data.order.id).toBe(ORDER_ID)
      expect(data.order.status).toBe("FULFILLED")
      expect(data.claim).toBeNull()
      expect(data.claimError).toBe(cryptoError)
    })

    it("puts the order id and status on the span, never the ciphertext or the claim", async () => {
      fulfilledOrder()

      await read()

      expect(mockAddAttributes).toHaveBeenCalledWith({
        "giftcard.orderId": ORDER_ID,
        "giftcard.status": "FULFILLED",
      })
      const traced = allMockCallText(mockAddAttributes)
      expect(traced).not.toContain(CIPHERTEXT)
      expect(traced).not.toContain(CLAIM_CODE)
    })
  })
})
