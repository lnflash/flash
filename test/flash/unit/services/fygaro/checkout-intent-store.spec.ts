const mockCacheSet = jest.fn()
const mockCacheGet = jest.fn()
const mockConsumeCacheKey = jest.fn()
const mockZadd = jest.fn()
const mockZrem = jest.fn()
const mockZrange = jest.fn()
const mockZremrangebyscore = jest.fn()
const mockExpire = jest.fn()

jest.mock("@services/cache", () => ({
  RedisCacheService: () => ({
    set: (...args: unknown[]) => mockCacheSet(...args),
    get: (...args: unknown[]) => mockCacheGet(...args),
  }),
  consumeCacheKey: (...args: unknown[]) => mockConsumeCacheKey(...args),
}))

jest.mock("@services/redis", () => ({
  redis: {
    zadd: (...args: unknown[]) => mockZadd(...args),
    zrem: (...args: unknown[]) => mockZrem(...args),
    zrange: (...args: unknown[]) => mockZrange(...args),
    zremrangebyscore: (...args: unknown[]) => mockZremrangebyscore(...args),
    expire: (...args: unknown[]) => mockExpire(...args),
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  consumeIntent,
  readIntent,
  releaseIntentReservation,
  saveIntent,
  sumOutstandingAuthorizedCents,
} from "@services/fygaro/checkout-intent-store"

const NOW_MS = 1_700_000_000_000
const TTL = 900

const INTENT = {
  intentId: "intent-1",
  accountId: "acct-1",
  username: "jaceth2009",
  amountCents: 8000,
  currency: "USD",
  createdAtMs: NOW_MS,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockCacheSet.mockResolvedValue(INTENT)
  mockCacheGet.mockResolvedValue(INTENT)
  mockConsumeCacheKey.mockResolvedValue(true)
  mockZadd.mockResolvedValue(1)
  mockZrem.mockResolvedValue(1)
  mockZrange.mockResolvedValue([])
  mockZremrangebyscore.mockResolvedValue(0)
  mockExpire.mockResolvedValue(1)
})

describe("saveIntent", () => {
  it("stores the record for longer than the JWT so a late payment is still verifiable", async () => {
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })

    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "fygaro-checkout-intent:intent-1",
        value: INTENT,
        ttlSecs: TTL + 3600,
      }),
    )
  })

  it("reserves the amount against the account, scored by when the JWT stops being payable", async () => {
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })

    expect(mockZadd).toHaveBeenCalledWith(
      "fygaro-checkout-intents:acct-1",
      NOW_MS + TTL * 1000,
      "8000:intent-1",
    )
  })

  it("reports a failed reservation write so the caller knows there is no hold", async () => {
    mockZadd.mockRejectedValue(new Error("redis down"))

    expect(await saveIntent({ intent: INTENT, ttlSeconds: TTL })).toBeInstanceOf(Error)
  })
})

describe("sumOutstandingAuthorizedCents", () => {
  it("sums the live authorisations for the account", async () => {
    mockZrange.mockResolvedValue(["8000:intent-1", "2500:intent-2"])

    expect(
      await sumOutstandingAuthorizedCents({ accountId: "acct-1", nowMs: NOW_MS }),
    ).toBe(10500)
  })

  it("drops authorisations whose JWT has already expired before summing", async () => {
    // Holding an abandoned, no-longer-payable link against the allowance would
    // lock the customer out for the rest of the window for nothing.
    await sumOutstandingAuthorizedCents({ accountId: "acct-1", nowMs: NOW_MS })

    expect(mockZremrangebyscore).toHaveBeenCalledWith(
      "fygaro-checkout-intents:acct-1",
      "-inf",
      NOW_MS,
    )
  })

  it("fails closed rather than reporting nothing outstanding", async () => {
    // "Nothing outstanding" is exactly the state that lets a second
    // full-allowance link be minted while the first is still payable.
    mockZrange.mockRejectedValue(new Error("redis down"))

    const result = await sumOutstandingAuthorizedCents({
      accountId: "acct-1",
      nowMs: NOW_MS,
    })

    expect(result).toBeInstanceOf(Error)
  })

  it("ignores a member it cannot parse instead of summing NaN", async () => {
    mockZrange.mockResolvedValue(["garbage", "2500:intent-2"])

    expect(
      await sumOutstandingAuthorizedCents({ accountId: "acct-1", nowMs: NOW_MS }),
    ).toBe(2500)
  })
})

describe("readIntent", () => {
  it("does NOT invalidate the intent it read", async () => {
    // The webhook consults this before it knows whether the delivery ends in a
    // terminal answer or a 500 asking the provider to retry.
    const lookup = await readIntent("intent-1")

    expect(lookup).toEqual({ found: true, intent: INTENT })
    expect(mockConsumeCacheKey).not.toHaveBeenCalled()
    expect(mockZrem).not.toHaveBeenCalled()
  })

  it("degrades to found:false on a cache failure rather than blocking a credit", async () => {
    // Failing the credit on a Redis blip would turn an outage into stuck
    // customer funds — the outcome this whole workstream exists to avoid.
    mockCacheGet.mockResolvedValue(new Error("redis down"))

    expect(await readIntent("intent-1")).toEqual({ found: false })
  })
})

describe("consumeIntent", () => {
  it("gates redemption on the atomic DEL, not on a get-then-clear", async () => {
    // `clear` discards the removed-count and always resolves true, so
    // get-then-clear is a TOCTOU race in which every concurrent consumer
    // "succeeds". Only the DEL removed-count picks a single winner.
    const result = await consumeIntent("intent-1")

    expect(mockConsumeCacheKey).toHaveBeenCalledWith({
      key: "fygaro-checkout-intent:intent-1",
    })
    expect(result).toEqual({ consumed: true })
  })

  it("reports the loser of a concurrent redemption as not consumed", async () => {
    mockConsumeCacheKey.mockResolvedValue(false)

    expect(await consumeIntent("intent-1")).toEqual({ consumed: false })
    // The winner releases the reservation; the loser must not touch it.
    expect(mockZrem).not.toHaveBeenCalled()
  })

  it("releases the account's reservation when it wins the claim", async () => {
    await consumeIntent("intent-1")

    expect(mockZrem).toHaveBeenCalledWith(
      "fygaro-checkout-intents:acct-1",
      "8000:intent-1",
    )
  })

  it("reports not-consumed when the claim itself errored", async () => {
    mockConsumeCacheKey.mockResolvedValue(new Error("redis down"))

    expect(await consumeIntent("intent-1")).toEqual({ consumed: false })
  })
})

describe("releaseIntentReservation", () => {
  it("removes only this authorisation's hold", async () => {
    await releaseIntentReservation({
      accountId: "acct-1",
      intentId: "intent-1",
      amountCents: 8000,
    })

    expect(mockZrem).toHaveBeenCalledWith(
      "fygaro-checkout-intents:acct-1",
      "8000:intent-1",
    )
  })

  it("never throws — the hold expires with the JWT anyway", async () => {
    mockZrem.mockRejectedValue(new Error("redis down"))

    await expect(
      releaseIntentReservation({
        accountId: "acct-1",
        intentId: "intent-1",
        amountCents: 8000,
      }),
    ).resolves.toBeUndefined()
  })
})
