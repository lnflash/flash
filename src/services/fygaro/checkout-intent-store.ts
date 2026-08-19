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
  // What the webhook decided about the payment made against this
  // authorisation. Written once the outcome is terminal, so the app can stop
  // guessing: today it navigates to "Payment Successful — Deposited to <wallet>"
  // off nothing but a Fygaro redirect URL, which is a claim we cannot back.
  //
  // Deliberately held HERE rather than read back from ERPNext. ERPNext is
  // already a hard dependency of authorising (its outage refuses top-ups);
  // putting it on the status path too would mean a customer who has just been
  // charged cannot even be told what happened. Redis outlives the poll window
  // by an hour, and the audit row remains the durable record.
  outcome?: FygaroTopupOutcome
}

export type FygaroTopupOutcomeState =
  // NON-TERMINAL, and the only state that means "a payment exists". Stamped by
  // the webhook the moment the payment is recorded, before any credit decision.
  //
  // Its absence is what makes "we have your payment" sayable at all: an intent
  // is written when the checkout link is MINTED, so a record with no outcome is
  // a customer who may never have paid — a declined card, a closed page — and
  // reading that as "processing" told them money had been received that never
  // left their account. `received` is the server actually knowing.
  | "received"
  // Credited. `netAmountCents` is what actually reached the wallet.
  | "credited"
  // Captured by Fygaro, deliberately not credited. Terminal until a human acts
  // — retrying changes nothing, so the customer must be told why.
  | "held-for-review"
  // Captured, we tried to credit, and the attempt failed (e.g. treasury float).
  // A provider retry may still resolve it, so this is "we are on it", not "go
  // to support".
  | "failed"

export type FygaroTopupOutcome = {
  state: FygaroTopupOutcomeState
  // The gate reason (`daily-limit-exceeded`, `over-limit`, …) or `credit-failed`.
  // Never set for `received`, which is an observation and not a decision.
  // Mapped to customer-facing wording at the GraphQL edge, never rendered raw.
  reason?: string
  netAmountCents?: number
  // The threshold the payment fell foul of, when there is one — the daily
  // limit, the single-payment ceiling, the minimum. Captured at decision time
  // so the customer-facing message can name the actual number without the
  // status query making a second ERPNext read on every poll.
  detailCents?: number
  // WHICH PAYMENT this outcome is about. The record is keyed on the intent, but
  // one signed link can be paid more than once inside its window — the very
  // replay `authorizeFygaroTopup` guards against — so an outcome without this
  // is an intent-scoped fact being read as a transaction-scoped one. The
  // webhook's already-credited short-circuit turns on exactly that distinction:
  // without it, tx2 against a link tx1 already credited is acked
  // `already_processed`, never stamped uncredited, never alerted, and reported
  // to the customer as CREDITED for money that never reached their wallet.
  //
  // Optional because records written before this field existed are still in
  // Redis. A guard comparing it must therefore require a MATCH rather than
  // accept an absent value, so a legacy record falls through to the ordinary
  // record-only path (alert + stamp) instead of being silently swallowed.
  transactionId?: string
  atMs: number
}

const cacheKey = (intentId: string) => `fygaro-checkout-intent:${intentId}`

/**
 * The single-use REDEMPTION claim, held in a key of its own.
 *
 * Redemption used to be the DEL of the record itself, which meant redeeming an
 * authorisation destroyed the very thing `recordIntentOutcome` writes to and
 * `readIntent` serves the status poll from — so `credited` and
 * `held-for-review` were never observable: on the record-only path the outcome
 * write found a deleted key and returned early, and on the credit path the
 * outcome was written and then deleted microseconds later. Every poll answered
 * "processing" for a payment that had already reached a terminal answer.
 *
 * Splitting the two keeps the exactly-once guarantee exactly where it was — the
 * DEL removed-count on THIS key still picks a single winner among concurrent
 * consumers — while the record lives out its full TTL so the customer can be
 * told what happened.
 */
const claimKey = (intentId: string) => `fygaro-checkout-claim:${intentId}`

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
  const cache = await cacheService()
  const res = await cache.set<FygaroCheckoutIntent>({
    key: cacheKey(intent.intentId),
    value: intent,
    ttlSecs: (ttlSeconds + 3600) as Seconds,
  })
  if (res instanceof Error) return res

  // The redemption claim, written alongside the record and living exactly as
  // long, so `consumeIntent` has something to DEL that is not the record the
  // status poll reads. Best-effort on purpose: the record and the reservation
  // are both in place by now, and failing the whole authorisation over the
  // claim would refuse a customer a checkout we can otherwise honour. Without
  // it no delivery can ever win the claim, so nothing is redeemed twice — the
  // hold simply waits for the JWT to expire instead of being released early,
  // the same bounded degradation `releaseIntentReservation` already accepts.
  const claim = await cache.set<string>({
    key: claimKey(intent.intentId),
    value: intent.intentId,
    ttlSecs: (ttlSeconds + 3600) as Seconds,
  })
  if (claim instanceof Error) {
    baseLogger.warn(
      { intentId: intent.intentId, error: claim.constructor.name },
      "Failed to write the Fygaro redemption claim; the hold will lift at expiry instead",
    )
  }

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
  //
  // `unavailable` marks the one sub-case that is NOT an answer about the
  // intent: the cache itself faulted, so "no record" is our ignorance rather
  // than a fact. Every caller on the money path still treats it as a miss —
  // that fail-open posture is what keeps a Redis blip from stranding captured
  // funds — but the status query needs the distinction, because telling a
  // customer who has just been charged that their checkout does not exist is
  // its own false claim.
  | { found: false; unavailable?: boolean }

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
      // A FAULT, not a miss. Every caller on the money path still treats it as
      // a miss; only the status query cares, and only so it can say "we cannot
      // confirm this yet" instead of "this checkout does not exist".
      return { found: false, unavailable: true }
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
 * The DEL lands on the CLAIM key, never on the record — see `claimKey`. Deleting
 * the record here is what made every terminal outcome unobservable, because the
 * outcome is stamped onto (and polled from) that record.
 *
 * Call this only on terminal outcomes — a delivery that will be retried must
 * leave the authorisation in place.
 */
export const consumeIntent = async (intentId: string): Promise<{ consumed: boolean }> => {
  // Read first, so this call knows which account reservation to release. The
  // read is not the gate; the DEL below is.
  const lookup = await readIntent(intentId)

  // Release BEFORE the claim gate, and regardless of who wins it. `zrem` is
  // idempotent — removing a member that is already gone is a no-op — so a
  // losing caller releasing costs nothing, while gating on the claim costs a
  // whole class of leaked holds:
  //
  //   - Every intent minted BEFORE the claim key existed has a record and no
  //     claim, so it can never win, and under a claim-gated release its hold
  //     would sit on the allowance until the JWT expired. For ttlSeconds+3600
  //     after any deploy that introduces the claim, those accounts hold
  //     allowance they have already spent and their next top-up is refused
  //     `checkout-already-open`.
  //   - A claim write that failed at saveIntent (best-effort, by design) puts a
  //     live intent in exactly the same position.
  //
  // The exactly-once guarantee is untouched: it lives in the DEL removed-count
  // below, which is what decides `consumed`, and releasing a hold is not a
  // redemption.
  if (lookup.found) await releaseIntentReservation(lookup.intent)

  const claimed = await (await cacheModule()).consumeCacheKey({ key: claimKey(intentId) })
  if (claimed instanceof Error) {
    baseLogger.warn({ intentId }, "Failed to consume Fygaro checkout intent")
    return { consumed: false }
  }
  if (!claimed) return { consumed: false }

  return { consumed: true }
}

/**
 * What the record should carry once `incoming` is applied to `existing`, or
 * `undefined` when the stamp must be DROPPED because the record already says
 * more than it does.
 *
 * Exported and pure so the ordering rules can be pinned directly. They are the
 * only thing standing between a customer and a status screen that walks
 * backwards, and every one of them is reachable from an ordinary provider
 * re-delivery.
 */
export const mergeIntentOutcome = (
  existing: FygaroTopupOutcome | undefined,
  incoming: FygaroTopupOutcome,
): FygaroTopupOutcome | undefined => {
  if (existing === undefined) return incoming

  // `received` is an OBSERVATION, and only ever the first thing known about a
  // payment. Every webhook delivery stamps it — including the re-delivery of a
  // payment an earlier delivery already credited or held — so letting it write
  // would walk a terminal answer backwards to "we're crediting it" and leave
  // the customer polling that forever. Terminal states are stamped by a
  // delivery that decided something; this one only saw a payment arrive.
  if (incoming.state === "received") return undefined

  // Is this stamp about a DIFFERENT payment from the one the record already
  // describes? Both ids must be present AND differ: an absent id is a record
  // written before `transactionId` existed (or a stamp that could not name its
  // payment), and treating "unknown" as "different" would let a legacy
  // `credited` be walked backwards by the very re-delivery the rules below
  // exist to stop. Unknown therefore stays absorbing; only a proven mismatch
  // opens the door.
  const differentPayment =
    existing.transactionId !== undefined &&
    incoming.transactionId !== undefined &&
    existing.transactionId !== incoming.transactionId

  // `credited` is ABSORBING — for THE SAME PAYMENT. The guard above stops
  // `received` walking a terminal answer backwards, but a LATER terminal answer
  // walks it backwards just as effectively, and that is reachable without any
  // race: delivery 2 of the same payment takes the webhook's unattributed
  // branch because the username no longer resolves, and stamps
  // `held-for-review`/`unattributed` over `credited`. The customer's screen
  // flips from "Money is in your wallet, $94.21" to "We've received your
  // payment and are completing it manually", and ops is paged for an
  // unattributed payment that is already in the wallet. There is no refund path
  // here, so credited is genuinely terminal.
  //
  // Terminal for that payment, though — not for the INTENT the record is keyed
  // on. One signed link can be paid more than once inside its 900s window (the
  // replay `authorizeFygaroTopup` guards against), and the webhook's
  // already-credited short-circuit is transaction-scoped for exactly that
  // reason: tx2 against a link tx1 already credited is refused on its own
  // merits and stamped `held-for-review`. Swallowing that stamp here would undo
  // the whole guard — the record would stay `credited` with tx1's net, and
  // `getFygaroTopupStatus` would answer CREDITED for a second real capture
  // sitting in manual review.
  // CREDITED IS ABSORBING, for the intent and not merely for the payment.
  //
  // The scoped version of this rule was still a "last stamp wins" fall-through
  // for any other transaction, and webhook deliveries are not a timeline: a
  // routine re-delivery of tx1 arriving after tx2 was refused walked the record
  // back and forth between "money is in your wallet" and "we're completing it
  // manually". Both stamps are true about their own payment; the record has one
  // slot, so the only rule that cannot produce a falsehood in SOME ordering is
  // to keep the claim that is irreversibly true. Money reaching the wallet is
  // that claim. A refusal is not — it is a payment ops may still hand-credit.
  //
  // The second, uncredited capture is not lost by this: it is transaction-
  // scoped everywhere it matters. `markFygaroTopupNotCredited` stamps its
  // ERPNext row, that row drops out of the 24h allowance sum, and alertBridge
  // pages a human. What it does not do is flip the customer's screen away from
  // a credit that genuinely landed.
  //
  // KNOWN GAP, deliberately left: a customer who pays the SAME link twice is
  // told about the credited one and not about the one in manual review. A
  // per-intent record cannot represent two payments; per-transaction status is
  // the real fix and is out of scope here.
  if (existing.state === "credited" && incoming.state !== "credited") {
    return undefined
  }

  // A later stamp must not DESTROY what an earlier one knew. The
  // already-credited guard in the webhook re-stamps `credited` from a path that
  // has no fee breakdown to hand, and a blind overwrite would drop the net that
  // a real credit recorded — leaving the app showing a credited top-up with no
  // amount, against a schema that promises `netAmount` is "present once
  // credited". Confirming an outcome should never know less than recording it.
  //
  // Scoped to the same payment for the same reason as the guard above: a net is
  // an amount that reached the wallet for ONE capture, so lending tx1's $94.21
  // to a stamp about tx2 would put a figure on the screen that no one credited
  // for that payment.
  if (existing.state === "credited" && !differentPayment) {
    return {
      ...incoming,
      netAmountCents: incoming.netAmountCents ?? existing.netAmountCents,
    }
  }

  return incoming
}

/**
 * Compare-and-set on the intent record: replace it ONLY if it still holds the
 * exact bytes the caller decided against, and keep its bounded lifetime.
 *
 * This is what makes the ordering rules above real. `recordIntentOutcome` was a
 * plain GET→SET on a key several concurrent deliveries write, so every
 * guarantee it leaned on held only while no write landed in between: delivery A
 * reads a record with no outcome, delivery B credits and writes `credited`, A
 * then writes its `received` over the top and the terminal answer is gone —
 * the customer polls PROCESSING for money already in their wallet, and the
 * webhook's already-credited marker, which reads this same field, silently
 * stops working. Neither of the webhook's locks serialises this call, and the
 * `received` stamp runs before either is taken.
 *
 * Deliberately GENERIC — no state names, no merge — so the decision has exactly
 * one implementation (`mergeIntentOutcome`, in TypeScript, unit-tested) and
 * this script cannot drift from it.
 *
 * A missing key returns `false` from GET, never equal to a string ARGV, so a
 * record that expired between the read and the swap is not resurrected.
 */
const CAS_INTENT_RECORD = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
redis.call('SETEX', KEYS[1], tonumber(ARGV[3]), ARGV[2])
return 1
`

// Contention here is a re-delivery storm on ONE payment, not sustained load, so
// a couple of retries covers it. Giving up is safe by construction: losing the
// swap means another delivery's answer is on the record, and the guard would
// have been re-evaluated against it.
const RECORD_OUTCOME_ATTEMPTS = 3

/**
 * Stamp the terminal outcome onto an authorisation, preserving everything else
 * about it.
 *
 * Read-modify-write rather than a blind overwrite: the record still carries the
 * amount and account the cross-check verifies against, and losing those to a
 * status update would silently disarm it. The write is a compare-and-set, so
 * the guard is evaluated against the value actually being replaced; a lost race
 * re-reads and decides again rather than clobbering the winner.
 *
 * Never throws and never blocks the caller — this runs on the webhook's
 * money-moving path, and a status write failing is not a reason to fail a
 * credit that already succeeded. A missing outcome degrades the app to
 * "we'll notify you", which is exactly what it shows while waiting anyway.
 */
export const recordIntentOutcome = async ({
  intentId,
  outcome,
  ttlSeconds,
}: {
  intentId: string
  outcome: FygaroTopupOutcome
  ttlSeconds: number
}): Promise<void> => {
  try {
    const redis = await redisClient()
    const key = cacheKey(intentId)
    // Written raw rather than through the cache service so the CAS has the
    // exact bytes to compare against. Same key, same JSON, same SETEX the cache
    // service issues, so `readIntent` reads it back unchanged.
    const ttl = String(ttlSeconds + 3600)

    for (let attempt = 0; attempt < RECORD_OUTCOME_ATTEMPTS; attempt++) {
      const raw = await redis.get(key)
      if (raw === null || raw === undefined) {
        // Expired, evicted, or a legacy payment with no intent at all. Nothing
        // to stamp; the app falls back to its unresolved state.
        return
      }

      const found = JSON.parse(raw) as FygaroCheckoutIntent
      const merged = mergeIntentOutcome(found.outcome, outcome)
      if (merged === undefined) return

      const next = JSON.stringify({ ...found, outcome: merged })
      const swapped = await redis.eval(CAS_INTENT_RECORD, 1, key, raw, next, ttl)
      if (Number(swapped) === 1) return
      // Another delivery replaced the record between the read and the swap, so
      // the decision above was made against a value that no longer exists. Read
      // the value that actually won and decide again against THAT.
    }

    baseLogger.warn(
      { intentId, state: outcome.state },
      "Gave up recording a Fygaro top-up outcome after repeated concurrent writes",
    )
  } catch (err) {
    baseLogger.warn(
      { intentId, error: err instanceof Error ? err.name : String(err) },
      "Failed to record Fygaro top-up outcome; app will fall back to pending",
    )
  }
}
