// jest.mock calls are hoisted before imports

const mockMasterGate = jest.fn()
const mockResolveCountry = jest.fn()
const mockGetGiftCardOrderForAccount = jest.fn()

jest.mock("@app/gift-cards", () => ({
  giftCardsMasterGate: (...a: unknown[]) => mockMasterGate(...a),
  resolveAccountCountryCodeOrUnknown: (...a: unknown[]) => mockResolveCountry(...a),
  getGiftCardOrderForAccount: (...a: unknown[]) => mockGetGiftCardOrderForAccount(...a),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  GiftCardClaimCryptoError,
  GiftCardOrderNotFoundError,
  GiftCardsDisabledError,
} from "@domain/gift-cards"
import GiftCardOrderQuery from "@graphql/public/root/query/gift-card-order"
import type { GiftCardOrderSource } from "@graphql/public/types/object/gift-card-order"

import { makeOrder } from "test/flash/unit/app/gift-cards/fixtures"

const ACCOUNT_ID = "account-001" as AccountId
const ORDER_ID = "order-1"

const ctx = {
  domainAccount: { id: ACCOUNT_ID, kratosUserId: "kratos-1", level: 1 },
} as unknown as GraphQLPublicContextAuth

const CLAIM: GiftCardClaim = {
  codes: [{ label: "Code", value: "ABCD-EFGH-1234" }],
  claimLink: "https://vendor.example/claim/abc",
  barcode: { chars: "1234567890", type: "CODE128" },
}

const resolve = async (id: string = ORDER_ID): Promise<GiftCardOrderSource | null> => {
  const query = GiftCardOrderQuery as unknown as {
    resolve: (
      source: null,
      args: { id: string },
      context: GraphQLPublicContextAuth,
      info: never,
    ) => Promise<GiftCardOrderSource | null>
  }
  return query.resolve(null, { id }, ctx, {} as never)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveCountry.mockResolvedValue("JM")
  mockMasterGate.mockReturnValue({ ok: true, providerId: "bitcoinCompany" })
  mockGetGiftCardOrderForAccount.mockResolvedValue({
    order: makeOrder({ status: "PAID", paidSats: 40_100 as Satoshis }),
    claim: null,
  })
})

describe("giftCardOrder resolver", () => {
  it("still reads the order when the rail is off (owner-scoped read of a paid order)", async () => {
    // Switching gift cards off must never hide codes a customer already paid
    // for, so this query deliberately does not consult the master gate.
    mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })

    await expect(resolve()).resolves.toMatchObject({ id: ORDER_ID })
    expect(mockMasterGate).not.toHaveBeenCalled()
    expect(mockGetGiftCardOrderForAccount).toHaveBeenCalledTimes(1)
  })

  it("asks only about THIS account's order", async () => {
    await resolve()

    // The account id comes from the session, never from the argument — the
    // order id alone must not be able to name whose order is being read.
    expect(mockGetGiftCardOrderForAccount).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      orderId: ORDER_ID,
    })
  })

  it("returns null for an unknown id or another account's order — indistinguishably", async () => {
    // The app layer answers GiftCardOrderNotFoundError for a non-owner, the
    // same as for a missing id. Null here, not an error, so the endpoint cannot
    // be used to confirm that someone else's order exists.
    mockGetGiftCardOrderForAccount.mockResolvedValue(new GiftCardOrderNotFoundError())

    expect(await resolve("someone-elses-order")).toBeNull()
  })

  it("throws the mapped error when the order exists but its claim cannot be read", async () => {
    // Not null: null means "not yours / does not exist", and this order is
    // both the caller's and real. A fault reading it is reported as a fault.
    mockGetGiftCardOrderForAccount.mockResolvedValue(new GiftCardClaimCryptoError())

    await expect(resolve()).rejects.toMatchObject({
      extensions: { code: "GIFT_CARD_CLAIM_UNAVAILABLE" },
    })
  })

  describe("the claim", () => {
    it("is absent before the order is FULFILLED", async () => {
      const result = await resolve()

      expect(result?.status).toBe("PAID")
      expect(result?.claim).toBeNull()
    })

    it("is dropped even if a claim arrives on a non-FULFILLED order", async () => {
      // Belt and braces: the app layer only decrypts once fulfilled, and the
      // mapper refuses to attach one otherwise.
      mockGetGiftCardOrderForAccount.mockResolvedValue({
        order: makeOrder({ status: "PAID" }),
        claim: CLAIM,
      })

      expect((await resolve())?.claim).toBeNull()
    })

    it("is returned, intact, for a FULFILLED order", async () => {
      const fulfilledAt = new Date("2026-09-09T10:00:00Z")
      mockGetGiftCardOrderForAccount.mockResolvedValue({
        order: makeOrder({
          status: "FULFILLED",
          paidSats: 40_100 as Satoshis,
          fulfilledAt,
          claimCiphertext: "enc:...",
          claimKeyId: "k1",
        }),
        claim: CLAIM,
      })

      const result = await resolve()

      expect(result?.status).toBe("FULFILLED")
      expect(result?.claim).toEqual(CLAIM)
      expect(result?.fulfilledAt).toBe(fulfilledAt)
      expect(result?.paidSats).toBe(40_100)
    })
  })

  it("never carries the ciphertext or key id onto the GraphQL source", async () => {
    mockGetGiftCardOrderForAccount.mockResolvedValue({
      order: makeOrder({
        status: "FULFILLED",
        claimCiphertext: "enc:should-never-leave",
        claimKeyId: "k1",
      }),
      claim: CLAIM,
    })

    const result = await resolve()

    expect(result).not.toHaveProperty("claimCiphertext")
    expect(result).not.toHaveProperty("claimKeyId")
    expect(JSON.stringify(result)).not.toContain("should-never-leave")
  })

  it("maps the order fields onto the wire names", async () => {
    const createdAt = new Date("2026-09-09T09:00:00Z")
    mockGetGiftCardOrderForAccount.mockResolvedValue({
      order: makeOrder({
        status: "FAILED",
        valueMinor: 2500,
        currency: "USD",
        quantity: 3,
        createdAt,
        failureReason: "vendor-create-failed: GiftCardVendorRejectedOrderError",
      }),
      claim: null,
    })

    const result = await resolve()

    expect(result).toEqual({
      id: "order-1",
      status: "FAILED",
      product: {
        name: "Amazon US",
        brand: "Amazon",
        countryCode: "US",
        currency: "USD",
        isOpenLoop: false,
        logoUrl: null,
      },
      value: 2500,
      currency: "USD",
      quantity: 3,
      paidSats: null,
      claim: null,
      createdAt,
      fulfilledAt: null,
      failureReason: "vendor-create-failed: GiftCardVendorRejectedOrderError",
    })
  })
})
