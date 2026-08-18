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

import { CacheUndefinedError, UnknownCacheServiceError } from "@domain/cache"
import { baseLogger } from "@services/logger"
import {
  consumeIntent,
  readIntent,
  readOutstandingReservations,
  recordIntentOutcome,
  releaseIntentReservation,
  saveIntent,
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

const sumOutstanding = async () => {
  const reservations = await readOutstandingReservations({
    accountId: "acct-1",
    nowMs: NOW_MS,
  })
  if (reservations instanceof Error) return reservations
  return reservations.reduce((sum, r) => sum + r.amountCents, 0)
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

  it("writes the redemption claim under its OWN key, not the record's", async () => {
    // Redemption DELs this key. If it DELed the record instead, redeeming an
    // authorisation would destroy the thing the status poll reads and the
    // terminal outcome is stamped onto.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })

    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "fygaro-checkout-claim:intent-1",
        ttlSecs: TTL + 3600,
      }),
    )
  })

  it("still authorises when only the claim write fails", async () => {
    // The record and the hold are both in place; the worst case is that no
    // delivery can win the claim, so the hold lifts at expiry instead of on
    // redemption. Refusing the customer a checkout over that is the wrong trade.
    mockCacheSet.mockImplementation(async ({ key }: { key: string }) =>
      key.startsWith("fygaro-checkout-claim:")
        ? new UnknownCacheServiceError("redis down")
        : INTENT,
    )

    expect(await saveIntent({ intent: INTENT, ttlSeconds: TTL })).toBe(true)
  })

  it("reports a failed reservation write so the caller knows there is no hold", async () => {
    mockZadd.mockRejectedValue(new Error("redis down"))

    expect(await saveIntent({ intent: INTENT, ttlSeconds: TTL })).toBeInstanceOf(Error)
  })
})

describe("readOutstandingReservations", () => {
  it("sums the live authorisations for the account", async () => {
    mockZrange.mockResolvedValue([
      "8000:intent-1",
      String(NOW_MS + 1000),
      "2500:intent-2",
      String(NOW_MS + 2000),
    ])

    expect(await sumOutstanding()).toBe(10500)
  })

  it("reports each hold's id and expiry, not just a total", async () => {
    // A refusal that cannot say WHEN the hold lifts is a dead end, and handing
    // an abandoned link back needs the intent id it is stored under.
    mockZrange.mockResolvedValue(["8000:intent-1", String(NOW_MS + 900_000)])

    expect(
      await readOutstandingReservations({ accountId: "acct-1", nowMs: NOW_MS }),
    ).toEqual([
      { intentId: "intent-1", amountCents: 8000, expiresAtMs: NOW_MS + 900_000 },
    ])
  })

  it("reads the scores, or the expiry would be unknowable", async () => {
    await readOutstandingReservations({ accountId: "acct-1", nowMs: NOW_MS })

    expect(mockZrange).toHaveBeenCalledWith(
      "fygaro-checkout-intents:acct-1",
      0,
      -1,
      "WITHSCORES",
    )
  })

  it("drops authorisations whose JWT has already expired before summing", async () => {
    // Holding an abandoned, no-longer-payable link against the allowance would
    // lock the customer out for the rest of the window for nothing.
    await readOutstandingReservations({ accountId: "acct-1", nowMs: NOW_MS })

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

    const result = await readOutstandingReservations({
      accountId: "acct-1",
      nowMs: NOW_MS,
    })

    expect(result).toBeInstanceOf(Error)
  })

  it("ignores a member it cannot parse instead of summing NaN", async () => {
    mockZrange.mockResolvedValue([
      "garbage",
      String(NOW_MS + 1000),
      "2500:intent-2",
      String(NOW_MS + 2000),
    ])

    expect(await sumOutstanding()).toBe(2500)
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

  it("does NOT warn on an ordinary cache miss", async () => {
    // RedisCacheService.get returns CacheUndefinedError for a plain miss, which
    // is what EVERY expired, evicted or already-redeemed intent looks like —
    // including every provider re-delivery after a successful redemption.
    // Warning on those turns the one line that should mean "Redis is broken"
    // into routine noise, and an unactionable line stops being read at all.
    mockCacheGet.mockResolvedValue(new CacheUndefinedError())

    expect(await readIntent("intent-1")).toEqual({ found: false })
    expect(baseLogger.warn).not.toHaveBeenCalled()
  })

  it("still warns on a real cache fault", async () => {
    mockCacheGet.mockResolvedValue(new UnknownCacheServiceError("redis down"))

    expect(await readIntent("intent-1")).toEqual({ found: false })
    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
  })
})

describe("consumeIntent", () => {
  it("gates redemption on the atomic DEL of the CLAIM key, not on a get-then-clear", async () => {
    // `clear` discards the removed-count and always resolves true, so
    // get-then-clear is a TOCTOU race in which every concurrent consumer
    // "succeeds". Only the DEL removed-count picks a single winner.
    //
    // And it must land on the claim key: DELing the record instead destroys
    // what `recordIntentOutcome` writes to and the status poll reads.
    const result = await consumeIntent("intent-1")

    expect(mockConsumeCacheKey).toHaveBeenCalledWith({
      key: "fygaro-checkout-claim:intent-1",
    })
    expect(mockConsumeCacheKey).not.toHaveBeenCalledWith({
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

// The whole point of the record/claim split. These run against a keyed
// in-memory Redis rather than blanket mock returns, because the bug they pin
// was invisible to blanket mocks: `mockCacheGet` answering with the intent for
// EVERY key cannot tell a live record from a deleted one, which is exactly the
// distinction that broke.
describe("redemption leaves the record the status poll reads", () => {
  const store = new Map<string, unknown>()

  beforeEach(() => {
    store.clear()
    mockCacheSet.mockImplementation(async ({ key, value }: Record<string, unknown>) => {
      store.set(key as string, value)
      return value
    })
    mockCacheGet.mockImplementation(async ({ key }: { key: string }) =>
      store.has(key) ? store.get(key) : new CacheUndefinedError(),
    )
    mockConsumeCacheKey.mockImplementation(async ({ key }: { key: string }) =>
      store.delete(key),
    )
  })

  const OUTCOME = {
    state: "held-for-review" as const,
    reason: "daily-limit-exceeded",
    detailCents: 2500,
    atMs: NOW_MS,
  }

  it("records a terminal outcome AFTER the authorisation was redeemed", async () => {
    // The webhook's record-only path redeems, then marks the ERPNext row, then
    // stamps the outcome. When redemption DELed the record, that stamp hit a
    // deleted key and returned early — so HELD_FOR_REVIEW, the state this whole
    // feature exists to deliver, was never observable and the customer polled
    // "processing" forever.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await consumeIntent(INTENT.intentId)

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: OUTCOME,
      ttlSeconds: TTL,
    })

    expect(await readIntent(INTENT.intentId)).toEqual({
      found: true,
      intent: { ...INTENT, outcome: OUTCOME },
    })
  })

  it("re-stamping credited without a net KEEPS the net already recorded", async () => {
    // The webhook's already-credited guard re-stamps `credited` from a path
    // with no fee breakdown in hand. A blind overwrite would drop the net a
    // real credit recorded, leaving the app showing a credited top-up with no
    // amount — against a schema that promises netAmount is present once
    // credited. Confirming an outcome must never know less than recording it.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 5652, atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", atMs: NOW_MS + 1000 },
      ttlSeconds: TTL,
    })

    const lookup = await readIntent(INTENT.intentId)
    expect(lookup).toMatchObject({
      found: true,
      intent: { outcome: { state: "credited", netAmountCents: 5652 } },
    })
  })

  it("lets a later credited stamp carry a net when the first had none", async () => {
    // The merge preserves, it does not freeze: new information still lands.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 5652, atMs: NOW_MS + 1000 },
      ttlSeconds: TTL,
    })

    expect(await readIntent(INTENT.intentId)).toMatchObject({
      intent: { outcome: { netAmountCents: 5652 } },
    })
  })

  it("does not carry a net across a state change", async () => {
    // Only credited->credited merges. A different state is a different answer
    // about the payment, and inheriting an amount from the previous one would
    // attach a credited figure to something that was not credited.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 5652, atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "failed", reason: "credit-failed", atMs: NOW_MS + 1000 },
      ttlSeconds: TTL,
    })

    const lookup = await readIntent(INTENT.intentId)
    expect(lookup).toMatchObject({ intent: { outcome: { state: "failed" } } })
    expect(
      (lookup as { intent: { outcome: { netAmountCents?: number } } }).intent.outcome
        .netAmountCents,
    ).toBeUndefined()
  })

  it("keeps an outcome written BEFORE redemption (the credit path's order)", async () => {
    // The credit path stamps `credited` and only then redeems. Redeeming must
    // not take the freshly-written outcome with it.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 7551, atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    await consumeIntent(INTENT.intentId)

    const lookup = await readIntent(INTENT.intentId)
    expect(lookup).toMatchObject({
      found: true,
      intent: { outcome: { state: "credited", netAmountCents: 7551 } },
    })
  })

  it("still redeems exactly once", async () => {
    // Splitting record from claim must not cost the exactly-once guarantee:
    // the DEL removed-count on the claim key is still what picks the winner.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })

    expect(await consumeIntent(INTENT.intentId)).toEqual({ consumed: true })
    expect(await consumeIntent(INTENT.intentId)).toEqual({ consumed: false })
    // Exactly one release, from the one winner.
    expect(mockZrem).toHaveBeenCalledTimes(1)
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
