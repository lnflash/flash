import { getAccountLimits, getSendGuardMode } from "@config"

import { usdFromBtcMidPriceFn } from "@app/prices/mid-price"

import { AccountLevel } from "@domain/accounts"
import {
  IntraledgerLimitsExceededError,
  WithdrawalLimitsExceededError,
} from "@domain/errors"
import {
  InvalidSendAmountError,
  SendLimitsUnavailableError,
} from "@domain/payments/errors"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { ErrorLevel, WalletCurrency } from "@domain/shared"

import { notifyOpsEvent } from "@services/alerts/ops-events"
import { consumeLimiter } from "@services/rate-limit"
import { recordExceptionInCurrentSpan } from "@services/tracing"

/**
 * ENG-573 Phase 0 — the send guard.
 *
 * Every user-initiated send mutation calls this before anything reaches IBEX.
 * Flash has no internal ledger, so Galoy's `AccountLimitsChecker` reads a
 * volume of zero for every account and never rejects; until the Phase 1
 * allowance counter exists this is the only Flash-side check on a send.
 *
 * Checks, in order:
 *   1. attempt budget  — two Redis buckets keyed on the account (burst + daily).
 *      Consumed FIRST so that a rejected attempt still costs a point: a caller
 *      probing the amount space is bounded by their own budget.
 *   2. amount sanity   — positive and finite. USD/USDT cents may be fractional
 *      (USDT settles in micros); sats must be whole.
 *   3. daily limit     — `amount <= dailyLimit(level)`. Per the ENG-573 decision
 *      the daily limit *is* the per-transaction cap; Phase 1 tightens this to
 *      the remaining allowance. Intraledger sends use the intraLedger limit,
 *      everything that leaves Flash uses the withdrawal limit.
 *
 * MODE (`sendGuard.mode` in yaml, `getSendGuardMode()` — default `log-only`):
 *
 *   off       returns immediately. No Redis, no price lookup, no ops event;
 *             sends behave exactly as they did before ENG-573. The escape
 *             hatch if the guard itself turns out to be the outage.
 *   log-only  DEFAULT. All checks run and every would-be rejection posts a
 *             `transfer / would-reject` ops event — but the send is authorised.
 *             This is the first Flash-side amount cap that has ever rejected
 *             anything and nobody has yet measured what fraction of real
 *             traffic it would refuse; in particular the ~300 prod accounts
 *             with no `level` field (174 with usernames) land on the level-0
 *             $125 cap. Read a day of `would-reject` events, confirm the
 *             distribution, then flip to enforce.
 *   enforce   rejections are real.
 *
 * Fails closed *when enforcing*: no limit configured for the level, no BTC→USD
 * price for a sats amount, or a rate-limit store fault all reject the send with
 * `SendLimitsUnavailableError`. Those are infrastructure faults, not user error
 * — they are reported to the ops feed AND recorded as span exceptions, so a
 * Redis or price-pod outage surfaces as "the guard is blocking sends" rather
 * than as a wave of unexplained payment failures.
 *
 * `rate-limited` rejections deliberately post NO ops event: the limiter has
 * already bounded that caller, its counters live in Redis, and a client in a
 * retry loop would otherwise flood the shared 50-deep ops queue and push the
 * verification / cashout / deposit feed out of it. `limits-unavailable` is
 * coalesced to one event per minute for the same reason — see
 * `OPS_EVENT_COALESCE_MS`.
 *
 * Not applied to system credits (rewards, referral payouts, top-up credits,
 * reimbursements): those call the `@app` layer directly and never pass
 * through a send mutation.
 */

export type SendKind = "intraledger" | "lightning" | "lnurl" | "onchain"

export type SendAmountInput =
  // Cents may arrive as a string: the FractionalCentAmount scalar is typed as a
  // branded string even though it parses to a float at runtime.
  | { currency: "USD"; cents: number | bigint | string }
  | { currency: "BTC"; sats: number | bigint }

// Rejection reasons the guard attaches to the ops event. The union is derived
// from the value, so the strings have exactly one source: the guard, the specs
// and the Phase 1 counter all reference these rather than retyping literals.
export const SendRejectionReasons = {
  rateLimited: "rate-limited",
  invalidAmount: "invalid-amount",
  overDailyLimit: "over-daily-limit",
  limitsUnavailable: "limits-unavailable",
} as const

export type SendRejectionReason =
  (typeof SendRejectionReasons)[keyof typeof SendRejectionReasons]

type AuthorizeSendArgs = {
  senderAccount: Account
  senderWalletId: WalletId
  amount: SendAmountInput
  kind: SendKind
}

type SendRejection = {
  error: ApplicationError
  reason: SendRejectionReason
  cents?: number
}

const usdDisplay = (cents: number) => ({
  value: (cents / 100).toFixed(2),
  currency: "USD",
})

/**
 * Ceiling on `limits-unavailable` ops events: at most one per window, with the
 * count of suppressed ones carried on the next event that posts.
 *
 * `rate-limited` is silent because the limiter has already bounded that caller.
 * `limits-unavailable` needs a ceiling for the opposite reason: nothing bounds
 * it. It is not a per-account fact at all — a Redis fault or a price-pod outage
 * past the 10-minute price cache makes EVERY send in flight report it at the
 * same instant. The shared ops queue is 50 deep, drains sequentially and drops
 * its oldest entries on overflow (`@services/alerts/ops-events`), so at any
 * real send rate a 30-second Redis blip would bury the verification / cashout /
 * deposit feed under identical `limits-unavailable` embeds plus "N events
 * dropped" summaries — during exactly the incident the mode switch was added to
 * survive, and making the log-only sample the rollout depends on silently
 * lossy. `recordExceptionInCurrentSpan` below is the durable, unthrottled
 * signal for this reason; docs/send-guard.md tells ops to alert on it.
 *
 * `over-daily-limit` and `invalid-amount` are NOT coalesced: they are
 * per-account facts (which account, which level, what amount) that the log-only
 * rollout exists to read one by one, and each caller's own attempt budget
 * already bounds how many they can produce.
 */
export const OPS_EVENT_COALESCE_MS = 60_000

const COALESCED_REASONS: ReadonlySet<SendRejectionReason> = new Set([
  SendRejectionReasons.limitsUnavailable,
])

const opsEventWindows = new Map<
  SendRejectionReason,
  { openedAt: number; muted: number }
>()

// Returns whether this rejection gets an ops event, and how many events of the
// same reason were muted since the last one that did.
const claimOpsEventSlot = (
  reason: SendRejectionReason,
): { post: false } | { post: true; muted: number } => {
  if (!COALESCED_REASONS.has(reason)) return { post: true, muted: 0 }

  const now = Date.now()
  const lastWindow = opsEventWindows.get(reason)
  if (lastWindow && now - lastWindow.openedAt < OPS_EVENT_COALESCE_MS) {
    lastWindow.muted += 1
    return { post: false }
  }

  // Muted events are counted onto the next event that posts, but only while
  // they are still the same news: a count carried out of a window that closed
  // long ago belongs to a different incident, so it is dropped rather than
  // pinned to an unrelated rejection.
  const carried =
    lastWindow && now - lastWindow.openedAt < 2 * OPS_EVENT_COALESCE_MS
      ? lastWindow.muted
      : 0

  opsEventWindows.set(reason, { openedAt: now, muted: 0 })
  return { post: true, muted: carried }
}

// An account document with no `level` field hydrates as `undefined` (the
// mongoose schema has no default; ~300 prod accounts are in this state). An
// unleveled account is an unverified one, so it gets the level-0 limits rather
// than a closed door. This assumption is exactly what `log-only` mode exists to
// verify before it can refuse anybody.
const effectiveLevel = (account: Account): AccountLevel =>
  account.level ?? AccountLevel.Zero

const toPositiveNumber = (
  raw: number | bigint | string,
  { integer }: { integer: boolean },
): number | InvalidSendAmountError => {
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    return new InvalidSendAmountError("Amount must be greater than zero")
  }
  if (integer && !Number.isInteger(value)) {
    return new InvalidSendAmountError("Amount must be a whole number")
  }
  return value
}

const usdCentsFromSendAmount = async (
  amount: SendAmountInput,
): Promise<{ cents: number } | SendRejection> => {
  if (amount.currency === "USD") {
    const cents = toPositiveNumber(amount.cents, { integer: false })
    if (cents instanceof Error) {
      return { error: cents, reason: SendRejectionReasons.invalidAmount }
    }
    return { cents }
  }

  const sats = toPositiveNumber(amount.sats, { integer: true })
  if (sats instanceof Error) {
    return { error: sats, reason: SendRejectionReasons.invalidAmount }
  }

  const usd = await usdFromBtcMidPriceFn({
    amount: BigInt(sats),
    currency: WalletCurrency.Btc,
  })
  if (usd instanceof Error) {
    return {
      error: new SendLimitsUnavailableError(`BTC→USD price unavailable: ${usd.message}`),
      reason: SendRejectionReasons.limitsUnavailable,
    }
  }
  return { cents: Number(usd.amount) }
}

/**
 * Runs the three checks and returns the first rejection, or `true`. Knows
 * nothing about the mode: whether a rejection actually stops the send is
 * `authorizeSend`'s decision.
 */
const evaluateSend = async ({
  senderAccount,
  amount,
  kind,
}: AuthorizeSendArgs): Promise<true | SendRejection> => {
  // 1. attempt budget — every attempt costs a point, rejected ones included
  for (const rateLimitConfig of [
    RateLimitConfig.paymentSend,
    RateLimitConfig.paymentSendDaily,
  ]) {
    const budget = await consumeLimiter({
      rateLimitConfig,
      keyToConsume: senderAccount.id,
    })
    if (budget instanceof RateLimiterExceededError) {
      return { error: budget, reason: SendRejectionReasons.rateLimited }
    }
    if (budget instanceof Error) {
      // Not a breach — the Redis store itself failed. Reported and alerted as an
      // infrastructure fault, and surfaced to the caller as the generic
      // "temporarily unavailable" rather than "too many attempts", which would
      // tell a user on their first send of the day that they are rate limited.
      return {
        error: new SendLimitsUnavailableError(
          `send attempt budget unavailable: ${budget.message}`,
        ),
        reason: SendRejectionReasons.limitsUnavailable,
      }
    }
  }

  // 2. amount sanity + normalisation to USD cents
  const normalised = await usdCentsFromSendAmount(amount)
  if ("error" in normalised) return normalised
  const { cents } = normalised

  // 3. daily limit for the level doubles as the per-transaction cap (Phase 0)
  const level = effectiveLevel(senderAccount)
  const limits = getAccountLimits({ level })
  const limit = kind === "intraledger" ? limits.intraLedgerLimit : limits.withdrawalLimit
  if (!Number.isFinite(limit)) {
    return {
      error: new SendLimitsUnavailableError(
        `no daily send limit configured for level ${level}`,
      ),
      reason: SendRejectionReasons.limitsUnavailable,
      cents,
    }
  }
  if (cents > limit) {
    const limitAsUsd = `$${(limit / 100).toFixed(2)}`
    const message = `Cannot transfer more than ${limitAsUsd} in 24 hours`
    return {
      error:
        kind === "intraledger"
          ? new IntraledgerLimitsExceededError(message)
          : new WithdrawalLimitsExceededError(message),
      reason: SendRejectionReasons.overDailyLimit,
      cents,
    }
  }

  return true
}

const report = ({
  rejection,
  mode,
  senderAccount,
  senderWalletId,
  kind,
}: {
  rejection: SendRejection
  mode: SendGuardMode
  senderAccount: Account
  senderWalletId: WalletId
  kind: SendKind
}): void => {
  const { error, reason, cents } = rejection
  const enforcing = mode === "enforce"

  // A rate-limited caller is already bounded by their own Redis budget, and
  // every further attempt still consumes, still rejects and would still post.
  // The shared ops queue is 50 deep and drops its oldest events on overflow, so
  // one client in a retry loop would bury the verification / cashout / deposit
  // feed under its own rejections — exactly when ops needs to read it.
  // `limits-unavailable` is unbounded in the other direction (every send at
  // once) and is coalesced instead of silenced — see OPS_EVENT_COALESCE_MS.
  const slot =
    reason === SendRejectionReasons.rateLimited
      ? { post: false as const }
      : claimOpsEventSlot(reason)
  if (slot.post) {
    notifyOpsEvent({
      flow: "transfer",
      // `would-reject` is not a euphemism: in log-only mode the send went
      // through. The feed must not read as if the guard blocked something.
      phase: enforcing ? "rejected" : "would-reject",
      status: enforcing ? "failed" : "pending",
      accountId: senderAccount.id,
      amount: cents === undefined ? undefined : usdDisplay(cents),
      // `step` is the one field buildEmbed does not run through truncateId
      // (12 chars), so the reason arrives whole — "over-daily-limit", not
      // "over-dai…". Everything in `meta` is truncated.
      step: reason,
      error: error.constructor.name,
      meta: {
        senderWalletId,
        kind,
        level: String(effectiveLevel(senderAccount)),
        mode,
        // How many events of this reason were coalesced away since the last one
        // that posted, so the feed stays countable rather than silently lossy.
        ...(slot.muted > 0 ? { muted: String(slot.muted) } : {}),
      },
    })
  }

  // Not a user doing something wrong: Redis or the price feed is down, and when
  // enforcing that stops every amount-bearing send on every rail. Record it so
  // on-call sees "the guard is blocking sends" instead of a wave of
  // unexplained payment failures.
  if (reason === SendRejectionReasons.limitsUnavailable) {
    recordExceptionInCurrentSpan({
      error,
      level: enforcing ? ErrorLevel.Critical : ErrorLevel.Warn,
      fallbackMsg: "ENG-573 send guard could not evaluate a send",
      attributes: {
        "sendGuard.mode": mode,
        "sendGuard.kind": kind,
        "sendGuard.accountId": senderAccount.id,
      },
    })
  }
}

export const authorizeSend = async (
  args: AuthorizeSendArgs,
): Promise<true | ApplicationError> => {
  const mode = getSendGuardMode()
  // Off is off: no Redis round-trip, no price lookup, no ops event. A guard
  // that cannot be turned off without a deploy is a new hard dependency in
  // front of every send on every rail.
  if (mode === "off") return true

  const outcome = await evaluateSend(args)
  if (outcome === true) return true

  report({
    rejection: outcome,
    mode,
    senderAccount: args.senderAccount,
    senderWalletId: args.senderWalletId,
    kind: args.kind,
  })

  return mode === "enforce" ? outcome.error : true
}
