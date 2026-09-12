// jest.mock calls are hoisted before imports

const mockMasterGate = jest.fn()
const mockResolveCountry = jest.fn()
const mockListGiftCardOrdersForAccount = jest.fn()

jest.mock("@app/gift-cards", () => ({
  giftCardsMasterGate: (...a: unknown[]) => mockMasterGate(...a),
  resolveAccountCountryCodeOrUnknown: (...a: unknown[]) => mockResolveCountry(...a),
  listGiftCardOrdersForAccount: (...a: unknown[]) =>
    mockListGiftCardOrdersForAccount(...a),
}))

jest.mock("@services/logger", () => ({
  // The error map binds `logger[error.level]`; a repository fault is Critical.
  baseLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
    fatal: jest.fn(),
  },
}))

import { UnknownRepositoryError } from "@domain/errors"
import { GiftCardsDisabledError } from "@domain/gift-cards"
import GiftCardOrdersQuery, {
  decodeGiftCardOrderCursor,
  encodeGiftCardOrderCursor,
} from "@graphql/public/root/query/gift-card-orders"
import type { GiftCardOrderSource } from "@graphql/public/types/object/gift-card-order"

import { makeOrder } from "test/flash/unit/app/gift-cards/fixtures"

const ACCOUNT_ID = "account-001" as AccountId

const ctx = {
  domainAccount: { id: ACCOUNT_ID, kratosUserId: "kratos-1", level: 1 },
} as unknown as GraphQLPublicContextAuth

type Connection = {
  edges: { node: GiftCardOrderSource; cursor: string }[]
  pageInfo: {
    hasNextPage: boolean
    hasPreviousPage: boolean
    startCursor: string | null
    endCursor: string | null
  }
}

const resolve = async (args: Record<string, unknown> = {}): Promise<Connection> => {
  const query = GiftCardOrdersQuery as unknown as {
    resolve: (
      source: null,
      args: Record<string, unknown>,
      context: GraphQLPublicContextAuth,
      info: never,
    ) => Promise<Connection>
  }
  return query.resolve(null, args, ctx, {} as never)
}

const NEWER_AT = new Date("2026-09-09T10:00:00.123Z")
const OLDER_AT = new Date("2026-09-08T10:00:00.456Z")

const NEWER = makeOrder({
  id: "order-newer" as GiftCardOrderId,
  status: "FULFILLED",
  createdAt: NEWER_AT,
  claimCiphertext: "enc:never-in-a-list",
  claimKeyId: "k1",
})
const OLDER = makeOrder({ id: "order-older" as GiftCardOrderId, createdAt: OLDER_AT })

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveCountry.mockResolvedValue("JM")
  mockMasterGate.mockReturnValue({ ok: true, providerId: "bitcoinCompany" })
  mockListGiftCardOrdersForAccount.mockResolvedValue({
    orders: [NEWER, OLDER],
    hasNextPage: true,
    endCursor: OLDER_AT,
  })
})

describe("gift card order cursors", () => {
  it("round-trip to the millisecond", () => {
    const at = new Date("2026-09-09T10:00:00.123Z")
    expect(decodeGiftCardOrderCursor(encodeGiftCardOrderCursor(at))?.getTime()).toBe(
      at.getTime(),
    )
  })

  it("reject garbage instead of decoding it to a date", () => {
    expect(decodeGiftCardOrderCursor("not-base64-of-a-date")).toBeNull()
    expect(
      decodeGiftCardOrderCursor(Buffer.from("yesterday").toString("base64")),
    ).toBeNull()
  })
})

describe("giftCardOrders resolver", () => {
  it("still lists orders when the rail is off (owner-scoped read of paid orders)", async () => {
    // Switching gift cards off must never hide codes a customer already paid
    // for, so this query deliberately does not consult the master gate.
    mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })

    await expect(resolve()).resolves.toBeDefined()
    expect(mockMasterGate).not.toHaveBeenCalled()
    expect(mockListGiftCardOrdersForAccount).toHaveBeenCalledTimes(1)
  })

  it("lists only THIS account's orders", async () => {
    await resolve({ first: 5 })

    expect(mockListGiftCardOrdersForAccount).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      first: 5,
      after: undefined,
    })
  })

  describe("arguments", () => {
    it("refuses a non-positive page size", async () => {
      await expect(resolve({ first: 0 })).rejects.toMatchObject({
        extensions: { code: "INVALID_INPUT" },
      })
      expect(mockListGiftCardOrdersForAccount).not.toHaveBeenCalled()
    })

    it("refuses an undecodable cursor", async () => {
      await expect(resolve({ after: "garbage" })).rejects.toMatchObject({
        extensions: { code: "INVALID_INPUT" },
      })
      expect(mockListGiftCardOrdersForAccount).not.toHaveBeenCalled()
    })

    it("decodes `after` into the Date the app layer pages on", async () => {
      await resolve({ after: encodeGiftCardOrderCursor(OLDER_AT) })

      expect(mockListGiftCardOrdersForAccount).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        first: undefined,
        after: OLDER_AT,
      })
    })
  })

  describe("connection shape", () => {
    it("wraps the page as relay edges with createdAt cursors", async () => {
      const result = await resolve()

      expect(result.edges.map((e) => e.node.id)).toEqual(["order-newer", "order-older"])
      expect(result.edges.map((e) => e.cursor)).toEqual([
        encodeGiftCardOrderCursor(NEWER_AT),
        encodeGiftCardOrderCursor(OLDER_AT),
      ])
      expect(result.pageInfo).toEqual({
        hasNextPage: true,
        hasPreviousPage: false,
        startCursor: encodeGiftCardOrderCursor(NEWER_AT),
        endCursor: encodeGiftCardOrderCursor(OLDER_AT),
      })
    })

    it("never includes a claim in a listing, even for a FULFILLED order", async () => {
      const result = await resolve()

      expect(result.edges[0].node.status).toBe("FULFILLED")
      expect(result.edges[0].node.claim).toBeNull()
      expect(JSON.stringify(result)).not.toContain("never-in-a-list")
      for (const edge of result.edges) {
        expect(edge.node).not.toHaveProperty("claimCiphertext")
        expect(edge.node).not.toHaveProperty("claimKeyId")
      }
    })

    it("returns an empty connection with null cursors for an empty page", async () => {
      mockListGiftCardOrdersForAccount.mockResolvedValue({
        orders: [],
        hasNextPage: false,
        endCursor: null,
      })

      const result = await resolve()

      expect(result.edges).toEqual([])
      expect(result.pageInfo).toEqual({
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      })
    })
  })

  it("throws the mapped error when the store cannot be read", async () => {
    mockListGiftCardOrdersForAccount.mockResolvedValue(new UnknownRepositoryError())

    await expect(resolve()).rejects.toMatchObject({
      extensions: { code: expect.any(String) },
    })
  })
})
