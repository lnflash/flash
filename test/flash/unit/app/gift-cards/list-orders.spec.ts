import { UnknownRepositoryError } from "@domain/errors"

let repo: FakeOrdersRepo

jest.mock("@services/mongoose", () => ({
  GiftCardOrdersRepository: () => repo,
}))

import {
  GIFT_CARD_ORDERS_DEFAULT_FIRST,
  GIFT_CARD_ORDERS_MAX_FIRST,
  listGiftCardOrdersForAccount,
} from "@app/gift-cards/list-orders"

import {
  ACCOUNT_ID,
  makeFakeOrdersRepo,
  makeOrder,
  NOW_MS,
  type FakeOrdersRepo,
} from "./fixtures"

const OTHER_ACCOUNT_ID = "6a8203ce490716aa69381499" as AccountId

/** `count` orders for the account, one minute apart, oldest first: order-0 is the oldest. */
const seedOrders = (count: number, accountId: AccountId = ACCOUNT_ID) => {
  for (let i = 0; i < count; i += 1) {
    repo.seed(
      makeOrder({
        id: `order-${i}` as GiftCardOrderId,
        accountId,
        status: "FULFILLED",
        claimCiphertext: `CIPHERTEXT-${i}`,
        claimKeyId: "k1",
        createdAt: new Date(NOW_MS + i * 60_000),
      }),
    )
  }
}

const list = (args: { first?: number; after?: Date } = {}) =>
  listGiftCardOrdersForAccount({ accountId: ACCOUNT_ID, ...args })

const ok = async (promise: ReturnType<typeof list>) => {
  const page = await promise
  if (page instanceof Error) throw page
  return page
}

beforeEach(() => {
  repo = makeFakeOrdersRepo()
})

describe("listGiftCardOrdersForAccount", () => {
  it("lists the account's orders newest first", async () => {
    seedOrders(3)

    const page = await ok(list())

    expect(page.orders.map((o) => o.id)).toEqual(["order-2", "order-1", "order-0"])
    expect(page.hasNextPage).toBe(false)
    expect(page.endCursor).toEqual(new Date(NOW_MS))
  })

  it("never returns another account's orders", async () => {
    seedOrders(2, OTHER_ACCOUNT_ID)
    seedOrders(1)

    const page = await ok(list())

    expect(page.orders.map((o) => o.id)).toEqual(["order-0"])
    expect(repo.listByAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID }),
    )
  })

  it("returns an empty page with a null cursor for an account with no orders", async () => {
    const page = await ok(list())

    expect(page).toEqual({ orders: [], hasNextPage: false, endCursor: null })
  })

  describe("page size", () => {
    it(`defaults to ${GIFT_CARD_ORDERS_DEFAULT_FIRST}`, async () => {
      seedOrders(GIFT_CARD_ORDERS_DEFAULT_FIRST + 5)

      const page = await ok(list())

      expect(page.orders).toHaveLength(GIFT_CARD_ORDERS_DEFAULT_FIRST)
      expect(page.hasNextPage).toBe(true)
    })

    it(`clamps first at ${GIFT_CARD_ORDERS_MAX_FIRST} and asks the store for one extra row`, async () => {
      seedOrders(GIFT_CARD_ORDERS_MAX_FIRST + 1)

      const page = await ok(list({ first: 10_000 }))

      expect(page.orders).toHaveLength(GIFT_CARD_ORDERS_MAX_FIRST)
      expect(page.hasNextPage).toBe(true)
      // One row past the page tells us whether another page exists, with no
      // count query.
      expect(repo.listByAccount).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        limit: GIFT_CARD_ORDERS_MAX_FIRST + 1,
        before: undefined,
      })
    })

    it.each([
      ["zero", 0],
      ["negative", -3],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("falls back to the default for a %s first", async (_label, first) => {
      seedOrders(GIFT_CARD_ORDERS_DEFAULT_FIRST + 1)

      const page = await ok(list({ first }))

      expect(page.orders).toHaveLength(GIFT_CARD_ORDERS_DEFAULT_FIRST)
      expect(page.hasNextPage).toBe(true)
    })

    it("floors a fractional first", async () => {
      seedOrders(5)

      const page = await ok(list({ first: 2.9 }))

      expect(page.orders).toHaveLength(2)
    })
  })

  describe("hasNextPage and endCursor", () => {
    it("is false when exactly `first` orders exist", async () => {
      seedOrders(3)

      const page = await ok(list({ first: 3 }))

      expect(page.orders).toHaveLength(3)
      expect(page.hasNextPage).toBe(false)
    })

    it("is true when one more order exists, and the extra row is not on the page", async () => {
      seedOrders(4)

      const page = await ok(list({ first: 3 }))

      expect(page.orders.map((o) => o.id)).toEqual(["order-3", "order-2", "order-1"])
      expect(page.hasNextPage).toBe(true)
    })

    it("endCursor is the createdAt of the last order on the page", async () => {
      seedOrders(4)

      const page = await ok(list({ first: 3 }))

      expect(page.endCursor).toEqual(new Date(NOW_MS + 1 * 60_000))
    })

    it("passing endCursor back as `after` continues where the page stopped, with no repeat and no gap", async () => {
      seedOrders(5)

      const first = await ok(list({ first: 2 }))
      expect(first.orders.map((o) => o.id)).toEqual(["order-4", "order-3"])
      expect(first.hasNextPage).toBe(true)

      const second = await ok(list({ first: 2, after: first.endCursor ?? undefined }))
      expect(second.orders.map((o) => o.id)).toEqual(["order-2", "order-1"])
      expect(second.hasNextPage).toBe(true)
      expect(repo.listByAccount).toHaveBeenLastCalledWith({
        accountId: ACCOUNT_ID,
        limit: 3,
        before: first.endCursor,
      })

      const third = await ok(list({ first: 2, after: second.endCursor ?? undefined }))
      expect(third.orders.map((o) => o.id)).toEqual(["order-0"])
      expect(third.hasNextPage).toBe(false)
      expect(third.endCursor).toEqual(new Date(NOW_MS))
    })
  })

  it("passes a repository fault through as the error", async () => {
    const fault = new UnknownRepositoryError("mongo down")
    repo.listByAccount.mockResolvedValueOnce(fault)

    expect(await list()).toBe(fault)
  })

  it("rides the stored ciphertext along but never a decrypted claim", async () => {
    // A listing is not where claims are read: `getGiftCardOrderForAccount`
    // decrypts, this does not. The order object is returned as stored.
    seedOrders(1)

    const page = await ok(list())

    expect(page.orders[0].claimCiphertext).toBe("CIPHERTEXT-0")
    expect(page.orders[0]).not.toHaveProperty("claim")
  })
})
