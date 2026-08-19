const mockCacheSet = jest.fn()
const mockCacheGet = jest.fn()
const mockConsumeCacheKey = jest.fn()
const mockZadd = jest.fn()
const mockZrem = jest.fn()
const mockZrange = jest.fn()
const mockZremrangebyscore = jest.fn()
const mockExpire = jest.fn()
const mockRedisGet = jest.fn()
const mockEval = jest.fn()

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
    get: (...args: unknown[]) => mockRedisGet(...args),
    eval: (...args: unknown[]) => mockEval(...args),
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { CacheUndefinedError, UnknownCacheServiceError } from "@domain/cache"
import { baseLogger } from "@services/logger"
import {
  consumeIntent,
  mergeIntentOutcome,
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
  mockRedisGet.mockResolvedValue(JSON.stringify(INTENT))
  mockEval.mockResolvedValue(1)
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

    expect(await readIntent("intent-1")).toMatchObject({ found: false })
  })

  it("marks a FAULT as unavailable, so a blip is not reported as 'never existed'", async () => {
    // The money paths keep treating it as a miss (fail-open). The status query
    // needs the distinction: without it, a customer who has just been charged
    // is told their checkout does not exist for as long as Redis is unwell.
    mockCacheGet.mockResolvedValue(new UnknownCacheServiceError("redis down"))

    expect(await readIntent("intent-1")).toEqual({ found: false, unavailable: true })
  })

  it("does NOT mark an ordinary miss as unavailable", async () => {
    // Every expired, evicted or already-redeemed intent is a plain miss. Marking
    // those unavailable would leave the app polling "we cannot confirm yet"
    // forever on a checkout id that is simply gone.
    mockCacheGet.mockResolvedValue(new CacheUndefinedError())

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

    expect(await readIntent("intent-1")).toMatchObject({ found: false })
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
  })

  it("releases the hold even when it LOSES the claim", async () => {
    // Gating the release on the claim leaks holds for a whole class of intents
    // that cannot win one: every record minted before the claim key existed,
    // and every record whose best-effort claim write failed at saveIntent.
    // Those accounts would hold allowance they have already spent until the JWT
    // expired, and their next top-up would be refused `checkout-already-open`.
    // `zrem` is idempotent, so releasing on a lost claim costs nothing; the
    // exactly-once guarantee lives in the DEL removed-count, not here.
    mockConsumeCacheKey.mockResolvedValue(false)

    await consumeIntent("intent-1")

    expect(mockZrem).toHaveBeenCalledWith(
      "fygaro-checkout-intents:acct-1",
      "8000:intent-1",
    )
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
  // Values are held as the RAW JSON strings redis actually stores, because
  // `recordIntentOutcome` now swaps the record with a compare-and-set on those
  // exact bytes. Holding parsed objects would make every CAS compare identity
  // instead of content and silently "succeed".
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    mockCacheSet.mockImplementation(async ({ key, value }: Record<string, unknown>) => {
      store.set(key as string, JSON.stringify(value))
      return value
    })
    mockCacheGet.mockImplementation(async ({ key }: { key: string }) => {
      const raw = store.get(key)
      return raw === undefined ? new CacheUndefinedError() : JSON.parse(raw)
    })
    mockConsumeCacheKey.mockImplementation(async ({ key }: { key: string }) =>
      store.delete(key),
    )
    mockRedisGet.mockImplementation(async (key: string) => store.get(key) ?? null)
    mockEval.mockImplementation(
      async (
        _script: string,
        _numKeys: number,
        key: string,
        expected: string,
        next: string,
      ) => cas(key, expected, next),
    )
  })

  // The Lua compare-and-set, in JS: replace ONLY if the key still holds the
  // exact bytes the caller decided against. No domain logic lives here — the
  // ordering rules are `mergeIntentOutcome`'s, and they run on the TS side.
  const cas = (key: string, expected: string, next: string) => {
    if ((store.get(key) ?? null) !== expected) return 0
    store.set(key, next)
    return 1
  }

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
    //
    // Demonstrated failed->held-for-review rather than credited->failed: the
    // credited case is no longer a state CHANGE at all, because credited is
    // absorbing (see "refuses to overwrite `credited` with a later failed"
    // below). The property being pinned here is unchanged.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: {
        state: "failed",
        reason: "credit-failed",
        netAmountCents: 5652,
        atMs: NOW_MS,
      },
      ttlSeconds: TTL,
    })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: {
        state: "held-for-review",
        reason: "daily-limit-exceeded",
        atMs: NOW_MS + 1000,
      },
      ttlSeconds: TTL,
    })

    const lookup = await readIntent(INTENT.intentId)
    expect(lookup).toMatchObject({ intent: { outcome: { state: "held-for-review" } } })
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
    // The guarantee is `consumed`, NOT how many times the idempotent release
    // ran — pinning the zrem count pinned an implementation detail, and it was
    // that detail (release gated on the claim) that leaked holds for every
    // intent minted before the claim key existed.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })

    expect(await consumeIntent(INTENT.intentId)).toEqual({ consumed: true })
    expect(await consumeIntent(INTENT.intentId)).toEqual({ consumed: false })
  })

  it("releases the hold on a record minted before the claim key existed", async () => {
    // The rollout window this change is really about: an intent written by the
    // previous deploy has a record and NO claim, so it can never win — and
    // under a claim-gated release its hold sat on the account's allowance for
    // ttlSeconds+3600, refusing its next top-up with `checkout-already-open`
    // for money it had already spent.
    store.set(`fygaro-checkout-intent:${INTENT.intentId}`, JSON.stringify(INTENT))

    expect(await consumeIntent(INTENT.intentId)).toEqual({ consumed: false })
    expect(mockZrem).toHaveBeenCalledWith(
      "fygaro-checkout-intents:acct-1",
      "8000:intent-1",
    )
  })

  it("keeps a `received` stamp from walking a terminal answer backwards", async () => {
    // The webhook stamps `received` on EVERY delivery, including the
    // re-delivery of a payment an earlier delivery already credited or held.
    // Letting that write would downgrade a terminal answer to "we're crediting
    // it" and leave the customer polling that forever, for a payment that has
    // already been decided.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 5652, atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "received", atMs: NOW_MS + 1000 },
      ttlSeconds: TTL,
    })

    expect(await readIntent(INTENT.intentId)).toMatchObject({
      intent: { outcome: { state: "credited", netAmountCents: 5652 } },
    })
  })

  it("records `received` when nothing is known about the payment yet", async () => {
    // The other half: the stamp has to LAND on a fresh intent, or the status
    // query has nothing to distinguish "we have your payment" from "you may
    // never have paid".
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "received", atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    expect(await readIntent(INTENT.intentId)).toMatchObject({
      intent: { outcome: { state: "received" } },
    })
  })

  it("refuses to overwrite `credited` with a later held-for-review", async () => {
    // No race needed to reach this: delivery 2 of the same payment takes the
    // webhook's unattributed branch because the username no longer resolves,
    // and stamps held-for-review/unattributed over credited. The customer's
    // screen flips from "Money is in your wallet, $94.21" to "We've received
    // your payment and are completing it manually", and ops gets paged for an
    // unattributed payment that is already in the wallet. There is no refund
    // path, so credited is terminal.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 9421, atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "held-for-review", reason: "unattributed", atMs: NOW_MS + 1000 },
      ttlSeconds: TTL,
    })

    expect(await readIntent(INTENT.intentId)).toMatchObject({
      intent: { outcome: { state: "credited", netAmountCents: 9421 } },
    })
  })

  it("refuses to overwrite `credited` with a later failed", async () => {
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 9421, atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "failed", reason: "credit-failed", atMs: NOW_MS + 1000 },
      ttlSeconds: TTL,
    })

    expect(await readIntent(INTENT.intentId)).toMatchObject({
      intent: { outcome: { state: "credited", netAmountCents: 9421 } },
    })
  })
  it("keeps CREDITED even when another payment on the same link is refused", async () => {
    // The record has one outcome slot and a link can be paid twice, so some
    // ordering of deliveries will always contradict some stamp. The only rule
    // that cannot produce a falsehood is to keep the claim that is
    // irreversibly true: money reached the wallet. A refusal is not that — it
    // is a capture ops may still hand-credit.
    //
    // The scoped version of this rule was still "last stamp wins" for any other
    // transaction, and webhook deliveries are not a timeline: a routine
    // RE-delivery of tx-1 after tx-2 was refused walked the record back and
    // forth between "money is in your wallet" and "we're completing it
    // manually".
    //
    // tx-2 is not lost by this — it is transaction-scoped everywhere it
    // matters: its ERPNext row is stamped uncredited, drops out of the 24h
    // allowance sum, and pages a human.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: {
        state: "credited",
        netAmountCents: 9421,
        transactionId: "tx-1",
        atMs: NOW_MS,
      },
      ttlSeconds: TTL,
    })

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: {
        state: "held-for-review",
        reason: "daily-limit-exceeded",
        detailCents: 12500,
        transactionId: "tx-2",
        atMs: NOW_MS + 1000,
      },
      ttlSeconds: TTL,
    })

    const lookup = await readIntent(INTENT.intentId)
    expect(lookup).toMatchObject({
      intent: {
        outcome: { state: "credited", netAmountCents: 9421, transactionId: "tx-1" },
      },
    })
  })

  it("cannot be walked back by a re-delivery of an earlier payment", async () => {
    // The failure the rule above exists to kill: once any payment credited,
    // no later stamp in any order flips the screen off it.
    await saveIntent({ intent: INTENT, ttlSeconds: TTL })
    for (const outcome of [
      { state: "held-for-review" as const, transactionId: "tx-2", atMs: NOW_MS },
      {
        state: "credited" as const,
        netAmountCents: 9421,
        transactionId: "tx-1",
        atMs: NOW_MS + 1,
      },
      { state: "held-for-review" as const, transactionId: "tx-2", atMs: NOW_MS + 2 },
      { state: "failed" as const, transactionId: "tx-3", atMs: NOW_MS + 3 },
    ]) {
      await recordIntentOutcome({ intentId: INTENT.intentId, outcome, ttlSeconds: TTL })
    }

    expect(await readIntent(INTENT.intentId)).toMatchObject({
      intent: { outcome: { state: "credited", netAmountCents: 9421 } },
    })
  })
})

// The guards above are only worth anything if they are evaluated against the
// value being REPLACED. This key is written by several concurrent deliveries of
// the same payment, and neither of the webhook's locks serialises the call —
// the `received` stamp runs before either is taken.
describe("recordIntentOutcome is a compare-and-set, not a read-then-blind-write", () => {
  const KEY = `fygaro-checkout-intent:${INTENT.intentId}`
  const CREDITED = { state: "credited" as const, netAmountCents: 5652, atMs: NOW_MS }

  it("swaps only against the exact bytes it decided on, keeping the record's TTL", async () => {
    const raw = JSON.stringify(INTENT)
    mockRedisGet.mockResolvedValue(raw)

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "received", atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    expect(mockEval).toHaveBeenCalledTimes(1)
    const [script, numKeys, key, expected, next, ttl] = mockEval.mock.calls[0]
    expect(script).toContain("GET")
    expect(numKeys).toBe(1)
    expect(key).toBe(KEY)
    // The value read, verbatim — not a re-serialisation of it, which would let
    // a concurrent writer's bytes compare equal to ours.
    expect(expected).toBe(raw)
    expect(JSON.parse(next).outcome).toMatchObject({ state: "received" })
    expect(ttl).toBe(String(TTL + 3600))
    // ...and never through the cache service's plain SET, which is what made
    // the guard a TOCTOU in the first place.
    expect(mockCacheSet).not.toHaveBeenCalled()
  })

  it("re-decides against the value that actually won when it loses the swap", async () => {
    // Delivery A reads a record with no outcome and decides to stamp
    // `received`; delivery B credits in between. A blind SET would erase the
    // terminal answer, leaving the customer polling PROCESSING for money
    // already in their wallet — and the webhook's already-credited marker,
    // which reads this same field, silently stops working.
    const stale = JSON.stringify(INTENT)
    const credited = JSON.stringify({ ...INTENT, outcome: CREDITED })
    mockRedisGet.mockResolvedValueOnce(stale).mockResolvedValue(credited)
    mockEval.mockResolvedValueOnce(0)

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "received", atMs: NOW_MS + 1 },
      ttlSeconds: TTL,
    })

    // The retry re-read the winner and the `received` guard dropped the stamp,
    // so there is no second swap at all.
    expect(mockEval).toHaveBeenCalledTimes(1)
    expect(mockRedisGet).toHaveBeenCalledTimes(2)
  })

  it("re-runs the merge, not just the write, after losing the swap", async () => {
    // The retry must re-evaluate: a terminal stamp that is still valid against
    // the winner has to land, or a lost race would silently drop it.
    const stale = JSON.stringify(INTENT)
    const received = JSON.stringify({
      ...INTENT,
      outcome: { state: "received", atMs: NOW_MS },
    })
    mockRedisGet.mockResolvedValueOnce(stale).mockResolvedValue(received)
    mockEval.mockResolvedValueOnce(0)

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 5652, atMs: NOW_MS + 1 },
      ttlSeconds: TTL,
    })

    expect(mockEval).toHaveBeenCalledTimes(2)
    expect(mockEval.mock.calls[1][3]).toBe(received)
    expect(JSON.parse(mockEval.mock.calls[1][4]).outcome).toMatchObject({
      state: "credited",
      netAmountCents: 5652,
    })
  })

  it("gives up quietly rather than looping on sustained contention", async () => {
    mockEval.mockResolvedValue(0)

    await expect(
      recordIntentOutcome({
        intentId: INTENT.intentId,
        outcome: { state: "credited", netAmountCents: 5652, atMs: NOW_MS },
        ttlSeconds: TTL,
      }),
    ).resolves.toBeUndefined()

    expect(mockEval).toHaveBeenCalledTimes(3)
    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
  })

  it("writes nothing when the record is gone", async () => {
    // Expired, evicted, or a legacy payment with no intent at all — never
    // resurrect it, or a redeemed authorisation comes back to life.
    mockRedisGet.mockResolvedValue(null)

    await recordIntentOutcome({
      intentId: INTENT.intentId,
      outcome: { state: "credited", netAmountCents: 5652, atMs: NOW_MS },
      ttlSeconds: TTL,
    })

    expect(mockEval).not.toHaveBeenCalled()
  })

  it("never throws on a redis fault — a status write must not fail a credit", async () => {
    mockRedisGet.mockRejectedValue(new Error("redis down"))

    await expect(
      recordIntentOutcome({
        intentId: INTENT.intentId,
        outcome: { state: "credited", netAmountCents: 5652, atMs: NOW_MS },
        ttlSeconds: TTL,
      }),
    ).resolves.toBeUndefined()
  })
})

// The ordering rules themselves, pinned directly rather than only through the
// store, because they are what stands between a customer and a status screen
// that walks backwards.
describe("mergeIntentOutcome", () => {
  const CREDITED = { state: "credited" as const, netAmountCents: 9421, atMs: NOW_MS }
  const HELD = {
    state: "held-for-review" as const,
    reason: "daily-limit-exceeded",
    atMs: NOW_MS + 1,
  }

  it("takes the first thing known about a payment", () => {
    expect(mergeIntentOutcome(undefined, { state: "received", atMs: NOW_MS })).toEqual({
      state: "received",
      atMs: NOW_MS,
    })
  })

  it("drops `received` once anything at all has been decided", () => {
    expect(
      mergeIntentOutcome(HELD, { state: "received", atMs: NOW_MS + 2 }),
    ).toBeUndefined()
  })

  it("drops every non-credited state against a credited record", () => {
    expect(mergeIntentOutcome(CREDITED, HELD)).toBeUndefined()
    expect(
      mergeIntentOutcome(CREDITED, {
        state: "failed",
        reason: "credit-failed",
        atMs: NOW_MS + 2,
      }),
    ).toBeUndefined()
  })

  it("drops a non-credited stamp even when it is about a DIFFERENT payment", () => {
    // Absorbing for the INTENT, not merely for the payment. Scoping it to the
    // payment left a "last stamp wins" fall-through for every other
    // transaction, and deliveries are not a timeline — a re-delivery of tx-1
    // after tx-2 was refused walked the record back and forth. One slot, two
    // payments: keep the claim that is irreversibly true.
    expect(
      mergeIntentOutcome(
        { ...CREDITED, transactionId: "tx-1" },
        { ...HELD, transactionId: "tx-2" },
      ),
    ).toBeUndefined()
  })

  it("does not lend one payment's net to a stamp about another", () => {
    // Not even to a later credit: a net is what reached the wallet for ONE
    // capture, and tx2's credit path always has its own figure to hand.
    expect(
      mergeIntentOutcome(
        { ...CREDITED, transactionId: "tx-1" },
        { state: "credited", transactionId: "tx-2", atMs: NOW_MS + 2 },
      )?.netAmountCents,
    ).toBeUndefined()
  })

  it("keeps `credited` absorbing when either side cannot name its payment", () => {
    // Records written before `transactionId` existed are still in Redis, and a
    // stamp that cannot name its payment says nothing about whether it is a
    // different one. Treating unknown as "different" would re-open the exact
    // regression the absorbing rule exists to stop — delivery 2 of the SAME
    // payment walking `credited` back to `held-for-review`/`unattributed`. So
    // unknown stays absorbing; only a proven mismatch opens the door.
    expect(
      mergeIntentOutcome(CREDITED, { ...HELD, transactionId: "tx-2" }),
    ).toBeUndefined()
    expect(
      mergeIntentOutcome({ ...CREDITED, transactionId: "tx-1" }, HELD),
    ).toBeUndefined()
    expect(
      mergeIntentOutcome(
        { ...CREDITED, transactionId: "tx-1" },
        { ...HELD, transactionId: "tx-1" },
      ),
    ).toBeUndefined()
  })

  it("keeps the net a real credit recorded when a confirmation carries none", () => {
    expect(
      mergeIntentOutcome(CREDITED, { state: "credited", atMs: NOW_MS + 2 }),
    ).toMatchObject({ state: "credited", netAmountCents: 9421 })
  })

  it("lets a later credited stamp carry its own net", () => {
    expect(
      mergeIntentOutcome(CREDITED, {
        state: "credited",
        netAmountCents: 8000,
        atMs: NOW_MS + 2,
      }),
    ).toMatchObject({ netAmountCents: 8000 })
  })

  it("does not carry a net across a state change", () => {
    const merged = mergeIntentOutcome(
      { state: "received", atMs: NOW_MS },
      { state: "held-for-review", reason: "under-minimum", atMs: NOW_MS + 1 },
    )

    expect(merged).toMatchObject({ state: "held-for-review" })
    expect(merged?.netAmountCents).toBeUndefined()
  })

  it("lets one terminal answer replace another that is not credited", () => {
    // `failed` is explicitly retryable, so a later decision about the same
    // payment is newer information and must land.
    expect(
      mergeIntentOutcome(
        { state: "failed", reason: "credit-failed", atMs: NOW_MS },
        HELD,
      ),
    ).toMatchObject({ state: "held-for-review" })
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
