import { randomUUID } from "crypto"

import { CacheUndefinedError } from "@domain/cache"
import { baseLogger } from "@services/logger"

import { FygaroReservationWriteError } from "./errors"

// Loaded on first use rather than at import time. `@services/cache` and
// `@services/redis` construct a Redis client as a module side effect, and this
// module is imported by the Fygaro webhook route — eagerly importing them would
// drag a live Redis connection into every consumer of that route, including its
// unit tests.
const cacheModule = () => import("@services/cache")
const cacheService = async () => (await cacheModule()).RedisCacheService()
const redisClient = async () => (await import("@services/redis")).redis

/**
 * What the server authorised, so the webhook can check what actually got paid
 * against it — and so the pre-charge allowance check can subtract links this
 * account is still holding.
 *
 * This store has TWO halves with OPPOSITE failure postures. Read both before
 * ruling Redis in or out of an incident:
 *
 *   - The RESERVATION INDEX (`readOutstandingReservations`) is FAIL-CLOSED, and
 *     `authorizeFygaroTopup` refuses when it cannot be read. Redis is therefore
 *     ON THE CRITICAL PATH for authorising a card top-up: if Redis is down,
 *     `fygaroCheckoutCreate` refuses every request with
 *     FYGARO_ALLOWANCE_UNAVAILABLE. Failing open here is what would let a second
 *     full-allowance link be minted against an allowance the first already
 *     spent, so this is deliberate — but it means "card top-ups are refusing"
 *     has Redis as a first-class suspect alongside ERPNext.
 *   - The CROSS-CHECK record (`readIntent`) is FAIL-OPEN: an unreadable intent
 *     is treated as "no authorisation on file", the same position every legacy
 *     payment is in, and the webhook's own credit gate still applies in full.
 *     Losing it never blocks a credit for a payment already captured.
 *
 * The signed JWT already prevents the customer editing the amount, so the
 * cross-check is not the primary defence — it is the record that lets us verify
 * the two independently, catch a signing/config mistake on our side, and make
 * each authorisation redeemable at most once.
 */
export type FygaroCheckoutIntent = {
  intentId: string
  accountId: string
  username: string
  amountCents: number
  currency: string
  createdAtMs: number
  // The signed link itself, so a customer who abandoned the payment page can be
  // handed their OWN live link back instead of being refused by the hold it
  // still has on their allowance. Optional because records written before this
  // field existed are still in Redis (and still verifiable); a record without
  // them simply cannot be re-offered.
  checkoutUrl?: string
  expiresAtMs?: number
}

const cacheKey = (intentId: string) => `fygaro-checkout-intent:${intentId}`

// Per-account index of authorisations that are still payable, so the pre-charge
// allowance check can subtract what it has already handed out. Without it,
// authorisation is not reservation: N calls against a $100 allowance each mint a
// $100 link, and paying two of them captures $200 while the webhook credits one
// — charged and uncredited, the incident this workstream exists to end.
//
// A sorted set scored by the JWT's expiry in epoch ms: entries past `now` are no
// longer payable (Fygaro rejects an expired token) and are pruned on read.
const accountIntentsKey = (accountId: string) => `fygaro-checkout-intents:${accountId}`

// `<amountCents>:<intentId>`. Amount first because an intentId is a uuid and
// carries no colon, so the split point is unambiguous either way, and a
// malformed member yields NaN which is dropped rather than summed.
const reservationMember = ({
  intentId,
  amountCents,
}: {
  intentId: string
  amountCents: number
}) => `${amountCents}:${intentId}`

const reservationAmountCents = (member: string): number => {
  const amount = Number(member.slice(0, member.indexOf(":")))
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

export const newIntentId = (): string => randomUUID()

export const saveIntent = async ({
  intent,
  ttlSeconds,
}: {
  intent: FygaroCheckoutIntent
  ttlSeconds: number
}): Promise<true | Error> => {
  // Outlive the JWT by a margin: a payment authorised at the very end of the
  // token's window still arrives (and must still be verifiable) minutes later,
  // once the customer has finished typing their card details.
  const res = await (
    await cacheService()
  ).set<FygaroCheckoutIntent>({
    key: cacheKey(intent.intentId),
    value: intent,
    ttlSecs: (ttlSeconds + 3600) as Seconds,
  })
  if (res instanceof Error) return res

  // The RESERVATION expires with the JWT, not with the record: once the token is
  // no longer payable the amount is no longer outstanding, even though the
  // record must stick around to verify a payment already in flight.
  try {
    const redis = await redisClient()
    const key = accountIntentsKey(intent.accountId)
    await redis.zadd(
      key,
      intent.createdAtMs + ttlSeconds * 1000,
      reservationMember(intent),
    )
    // Bounded lifetime for the index itself, so an account that stops topping
    // up does not leave a key behind forever.
    await redis.expire(key, ttlSeconds + 3600)
  } catch (err) {
    return new FygaroReservationWriteError(
      err instanceof Error ? err.message : String(err),
    )
  }

  return true
}

/**
 * One live, unredeemed authorisation this account is still holding.
 *
 * `expiresAtMs` is the zset score — the moment the JWT stops being payable and
 * the hold therefore stops counting against the allowance. The caller needs it
 * to tell a refused customer WHEN their allowance frees up, which is the
 * difference between an actionable refusal and a dead end.
 */
export type FygaroReservation = {
  intentId: string
  amountCents: number
  expiresAtMs: number
}

/**
 * The live, unredeemed authorisations this account is still holding.
 *
 * FAIL-CLOSED (returns the error) rather than resolving to an empty list:
 * treating an unreadable index as "nothing outstanding" is precisely the state
 * that lets a second link be minted against an allowance the first one already
 * spent. See the type docstring above — this is the half that puts Redis on the
 * critical path for authorising a top-up.
 */
export const readOutstandingReservations = async ({
  accountId,
  nowMs,
}: {
  accountId: string
  nowMs: number
}): Promise<FygaroReservation[] | Error> => {
  try {
    const redis = await redisClient()
    const key = accountIntentsKey(accountId)
    // Drop everything whose JWT has expired before reading: those URLs cannot
    // be paid any more, so holding their amount against the allowance would
    // lock a customer out for the rest of the window for links they abandoned.
    await redis.zremrangebyscore(key, "-inf", nowMs)
    // WITHSCORES: the score IS the expiry, and a refusal that cannot say when
    // the hold lifts is the same dead end as no refusal reason at all.
    const flat = await redis.zrange(key, 0, -1, "WITHSCORES")

    const reservations: FygaroReservation[] = []
    for (let i = 0; i < flat.length; i += 2) {
      const member = flat[i]
      const amountCents = reservationAmountCents(member)
      // A member we cannot parse is dropped rather than summed as NaN.
      if (amountCents <= 0) continue
      const expiresAtMs = Number(flat[i + 1])
      reservations.push({
        intentId: member.slice(member.indexOf(":") + 1),
        amountCents,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : nowMs,
      })
    }
    return reservations
  } catch (err) {
    baseLogger.warn(
      { accountId, error: err instanceof Error ? err.constructor.name : String(err) },
      "Failed to read outstanding Fygaro checkout authorisations",
    )
    return err instanceof Error ? err : new Error(String(err))
  }
}

/**
 * Drop an authorisation's hold on the allowance without invalidating the record.
 *
 * Used to roll back a reservation we decided not to hand out, and by
 * `consumeIntent` once the authorisation has actually been redeemed.
 */
export const releaseIntentReservation = async ({
  accountId,
  intentId,
  amountCents,
}: {
  accountId: string
  intentId: string
  amountCents: number
}): Promise<void> => {
  try {
    const redis = await redisClient()
    await redis.zrem(
      accountIntentsKey(accountId),
      reservationMember({ intentId, amountCents }),
    )
  } catch (err) {
    // The entry expires with the JWT anyway, so the worst case is that the
    // customer's allowance frees up at `exp` instead of immediately.
    baseLogger.warn(
      { accountId, intentId, error: err instanceof Error ? err.constructor.name : err },
      "Failed to release Fygaro checkout reservation",
    )
  }
}

export type IntentLookup =
  | { found: true; intent: FygaroCheckoutIntent }
  // Expired, evicted, already consumed, or minted by a different deployment.
  | { found: false }

/**
 * Read an intent WITHOUT invalidating it.
 *
 * Deliberately non-destructive: the webhook consults this before it knows
 * whether the delivery will end in a terminal answer or a 500 asking the
 * provider to retry. Consuming here would burn the authorisation on the retry
 * path, so the delivery that actually credits the payment — the one most worth
 * verifying — would arrive with nothing to check against.
 *
 * A cache failure returns `found: false` rather than an error: the caller
 * treats an unverifiable intent as "no authorisation on file" and falls through
 * to the credit gate, which is the same position every legacy payment is in.
 * Failing the credit outright here would turn a Redis blip into stuck customer
 * funds — the exact outcome this whole workstream exists to avoid.
 */
export const readIntent = async (intentId: string): Promise<IntentLookup> => {
  const cache = await cacheService()
  const found = await cache.get<FygaroCheckoutIntent>({ key: cacheKey(intentId) })
  if (found instanceof Error) {
    // A plain cache MISS is the ordinary case, not a fault: every expired,
    // evicted or already-redeemed intent lands here, including every provider
    // re-delivery of a payment whose intent the first delivery redeemed.
    // Warning on all of those turns the one line that should mean "Redis is
    // broken" into routine noise. The caller already logs the miss with the
    // transaction id, so this side stays silent for it.
    if (!(found instanceof CacheUndefinedError)) {
      baseLogger.warn(
        { intentId, error: found.constructor.name },
        "Fygaro checkout intent lookup failed; treating payment as unauthorised-legacy",
      )
    }
    return { found: false }
  }
  return { found: true, intent: found }
}

/**
 * Redeem an intent, atomically, so exactly one caller can claim a given
 * authorisation.
 *
 * The claim is gated on `consumeCacheKey`, whose DEL removed-count is the only
 * thing that distinguishes the winner: `clear` discards that count and always
 * resolves `true`, which makes get-then-`clear` a TOCTOU race in which every
 * concurrent consumer "succeeds" (see the docstring on `consumeCacheKey`).
 *
 * Call this only on terminal outcomes — a delivery that will be retried must
 * leave the authorisation in place.
 */
export const consumeIntent = async (intentId: string): Promise<{ consumed: boolean }> => {
  // Read first, purely so a winning claim knows which account reservation to
  // release. The read is not the gate; the DEL below is.
  const lookup = await readIntent(intentId)

  const claimed = await (await cacheModule()).consumeCacheKey({ key: cacheKey(intentId) })
  if (claimed instanceof Error) {
    baseLogger.warn({ intentId }, "Failed to consume Fygaro checkout intent")
    return { consumed: false }
  }
  if (!claimed) return { consumed: false }

  if (lookup.found) await releaseIntentReservation(lookup.intent)
  return { consumed: true }
}
