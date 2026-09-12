// jest.mock calls are hoisted before imports

const mockMasterGate = jest.fn()
const mockResolveCountry = jest.fn()
const mockListGiftCardProducts = jest.fn()

jest.mock("@app/gift-cards", () => ({
  giftCardsMasterGate: (...a: unknown[]) => mockMasterGate(...a),
  resolveAccountCountryCodeOrUnknown: (...a: unknown[]) => mockResolveCountry(...a),
  listGiftCardProducts: (...a: unknown[]) => mockListGiftCardProducts(...a),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  GiftCardCatalogUnavailableError,
  GiftCardProviderUnavailableError,
  GiftCardsDisabledError,
} from "@domain/gift-cards"
import { InputValidationError } from "@graphql/error"
import GiftCardCatalogQuery from "@graphql/public/root/query/gift-card-catalog"

import { makeProduct } from "test/flash/unit/app/gift-cards/fixtures"

const ACCOUNT_ID = "account-001" as AccountId
const KRATOS_USER_ID = "kratos-1" as UserId

const ctx = {
  domainAccount: { id: ACCOUNT_ID, kratosUserId: KRATOS_USER_ID, level: 1 },
} as unknown as GraphQLPublicContextAuth

type Connection = {
  edges: { node: GiftCardProduct; cursor: string }[]
  pageInfo: {
    hasNextPage: boolean
    hasPreviousPage: boolean
    startCursor: string | null
    endCursor: string | null
  }
}

const resolve = async (args: Record<string, unknown> = {}): Promise<Connection> => {
  const query = GiftCardCatalogQuery as unknown as {
    resolve: (
      source: null,
      args: Record<string, unknown>,
      context: GraphQLPublicContextAuth,
      info: never,
    ) => Promise<Connection>
  }
  return query.resolve(null, args, ctx, {} as never)
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

const AMAZON = makeProduct({ id: "bitcoinCompany:amazon-us" as GiftCardProductId })
const UBER = makeProduct({
  id: "bitcoinCompany:uber-us" as GiftCardProductId,
  providerProductId: "uber-us",
  name: "Uber",
  brand: "Uber",
})

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveCountry.mockResolvedValue("JM")
  mockMasterGate.mockReturnValue({ ok: true, providerId: "bitcoinCompany" })
  mockListGiftCardProducts.mockResolvedValue({
    products: [AMAZON, UBER],
    hasNextPage: true,
    endCursor: b64(UBER.id),
    stale: false,
  })
})

describe("giftCardCatalog resolver", () => {
  describe("master gate", () => {
    it("throws GIFT_CARDS_DISABLED when the rail is off, without reading the catalog", async () => {
      mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })

      await expect(resolve()).rejects.toMatchObject({
        extensions: { code: "GIFT_CARDS_DISABLED" },
      })
      expect(mockListGiftCardProducts).not.toHaveBeenCalled()
    })

    it("throws GIFT_CARD_PROVIDER_UNAVAILABLE when no enabled provider serves the country", async () => {
      mockMasterGate.mockReturnValue({
        ok: false,
        error: new GiftCardProviderUnavailableError(),
      })

      await expect(resolve()).rejects.toMatchObject({
        extensions: { code: "GIFT_CARD_PROVIDER_UNAVAILABLE" },
      })
      expect(mockListGiftCardProducts).not.toHaveBeenCalled()
    })
  })

  describe("country", () => {
    it("defaults to the calling account's country, and lists THAT country", async () => {
      await resolve()

      expect(mockResolveCountry).toHaveBeenCalledWith(ctx.domainAccount)
      expect(mockMasterGate).toHaveBeenCalledWith("JM")
      expect(mockListGiftCardProducts).toHaveBeenCalledWith(
        expect.objectContaining({ countryCode: "JM" }),
      )
    })

    it("uses an explicit countryCode for both the gate and the list, without resolving the account's", async () => {
      await resolve({ countryCode: "US" })

      expect(mockResolveCountry).not.toHaveBeenCalled()
      expect(mockMasterGate).toHaveBeenCalledWith("US")
      expect(mockListGiftCardProducts).toHaveBeenCalledWith(
        expect.objectContaining({ countryCode: "US" }),
      )
    })

    it("throws the scalar's validation error for a malformed countryCode", async () => {
      await expect(
        resolve({
          countryCode: new InputValidationError({
            message: "Invalid value for CountryCode",
          }),
        }),
      ).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } })
      expect(mockMasterGate).not.toHaveBeenCalled()
      expect(mockListGiftCardProducts).not.toHaveBeenCalled()
    })
  })

  it("passes the filters and page arguments through, dropping nulls", async () => {
    await resolve({ category: "Shopping", search: "ama", first: 10, after: "abc" })

    expect(mockListGiftCardProducts).toHaveBeenCalledWith({
      countryCode: "JM",
      category: "Shopping",
      search: "ama",
      first: 10,
      after: "abc",
    })

    await resolve({ category: null, search: null, first: null, after: null })

    expect(mockListGiftCardProducts).toHaveBeenLastCalledWith({
      countryCode: "JM",
      category: undefined,
      search: undefined,
      first: undefined,
      after: undefined,
    })
  })

  it("refuses a non-positive page size before the gate", async () => {
    await expect(resolve({ first: 0 })).rejects.toMatchObject({
      extensions: { code: "INVALID_INPUT" },
    })
    expect(mockListGiftCardProducts).not.toHaveBeenCalled()
  })

  describe("connection shape", () => {
    it("wraps the page as relay edges with the app layer's cursor encoding", async () => {
      const result = await resolve()

      expect(result.edges).toEqual([
        { node: AMAZON, cursor: b64(AMAZON.id) },
        { node: UBER, cursor: b64(UBER.id) },
      ])
      expect(result.pageInfo).toEqual({
        hasNextPage: true,
        hasPreviousPage: false,
        startCursor: b64(AMAZON.id),
        endCursor: b64(UBER.id),
      })
    })

    it("stamps every edge with a cursor the app layer's `after` accepts", async () => {
      // The app decodes `after` as base64 of the product id and resumes AFTER
      // it. An edge cursor in any other encoding would restart the list from
      // the top on every page — a paginator that never advances.
      const result = await resolve()

      for (const edge of result.edges) {
        expect(Buffer.from(edge.cursor, "base64").toString("utf8")).toBe(edge.node.id)
      }
      expect(result.pageInfo.endCursor).toBe(result.edges[1].cursor)
    })

    it("returns an empty connection with null cursors for an empty page", async () => {
      mockListGiftCardProducts.mockResolvedValue({
        products: [],
        hasNextPage: false,
        endCursor: null,
        stale: false,
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

  it("throws the mapped app error when the catalog cannot be read", async () => {
    mockListGiftCardProducts.mockResolvedValue(new GiftCardCatalogUnavailableError())

    await expect(resolve()).rejects.toMatchObject({
      extensions: { code: "GIFT_CARD_CATALOG_UNAVAILABLE" },
    })
  })
})
