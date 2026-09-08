import { getAccountLimits, getSendGuardMode } from "@config"

import { usdFromBtcMidPriceFn } from "@app/prices/mid-price"

import { effectiveAccountLevel } from "@domain/accounts"
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
import {
  addAttributesToCurrentSpan,
  asyncRunInSpan,
  recordExceptionInCurrentSpan,
  SemanticAttributes,
} from "@services/tracing"

/**
 * ENG-573 Phase 0 — the send guard.
 *
 * Every send mutation calls this before anything reaches IBEX. Flash has no
 * internal ledger, so Galoy's `AccountLimitsChecker` reads a volume of zero for
 * every account and never rejects; until the Phase 1 allowance counter exists
 * this is the only Flash-side check on the send mutations. It is NOT the only
 * user-initiated path that moves a user's money:
 *   - cashout pays a bolt11 out of the user's own wallet from
 *     `ValidOffer.execute` (@app/offers) with no attempt budget and no daily
 *     cap, bounded only by `Cashout.validations`;
 *   - `bridgeInitiateWithdrawal` sends the user's own USDT out through
 *     `IbexClient.sendCrypto` (@services/bridge `initiateWithdrawal`) with no
 *     attempt budget, no `accountLimits` cap and no configured min/max at all —
 *     its only controls are a Bridge KYC-approved customer, account level >= 1,
 *     and an execution-time balance re-check, on the largest per-transaction
 *     amounts on the platform.
 * See "Not covered by the guard at all" in docs/send-guard.md.
 *
 * Checks, in order:
 *   1. attempt budget  — two Redis buckets keyed on the account (burst + daily).
 *      Consumed FIRST so that a rejected attempt still costs a point: a caller
 *      probing the amount space is bounded by their own budget.
 *   2. amount sanity   — positive and finite. USD/USDT cents may be fractional
 *      (USDT settles in micros); sats must be whole.
 *   3. daily limit     — `amount <= dailyLimit(level)`. Per the ENG-573 decision
 *      the daily limit *is* the per-transaction cap; Phase 1 tightens this to
 *      the remaining allowance. `kind === "intraledger"` uses the intraLedger
 *      limit; every lightning, lnurl and on-chain rail uses the withdrawal
 *      limit. That is the RAIL, not the destination: a bolt11 or LN-address
 *      payment to another Flash user never leaves Flash but still arrives here
 *      as `lightning` / `lnurl`, because the destination is not resolved until
 *      the payment flow is built, after the guard. The approximation is only
 *      observable at level 1, the one level whose defaults differ ($1,000
 *      withdrawal vs $2,000 intraLedger); levels 0, 2 and 3 carry equal limits.
 *      docs/send-guard.md, check 3, says which way to settle it before
 *      enforcing.
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
 * EVERY rejection, coalesced or not, also lands on a span named
 * `app.payments.authorizeSend` as `sendGuard.*` attributes — the guard opens
 * that span itself (`SEND_GUARD_SPAN_NAME`) rather than writing to whatever
 * span happens to be active, so one query counts every rail. The ops feed, by
 * contrast, is fire-and-forget: it no-ops entirely when
 * `OPS_DISCORD_WEBHOOK_URL` is unset, drops its oldest entries on overflow with
 * only an unattributed "N events dropped" summary, and coalesces the unbounded
 * reasons. That makes it a fine place to *read* a rejection and a bad one to
 * *count* rejections — and the go/no-go for `enforce` is a count. The span
 * attributes are the countable instrument; the feed is the human one.
 *
 * The unbounded reasons are coalesced to one ops event per minute — see
 * `OPS_EVENT_COALESCE_MS` and `COALESCED_REASONS`.
 *
 * Not applied to system credits (rewards, referral payouts, top-up credits,
 * reimbursements): those call the `@app` layer directly and never pass
 * through a send mutation. Not applied to cashout either — that one is a gap,
 * not a decision; docs/send-guard.md says so in the operator's own words.
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
  // lnInvoicePaymentSend only: the bolt11 could not be decoded, or carried no
  // amount. Its own reason so the rollout can count a rejection class this rail
  // never had before the guard introduced the decode.
  undecodableInvoice: "undecodable-invoice",
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
 * Ceiling on the ops events of a coalesced reason: at most one per window, with
 * the count of suppressed ones carried on the next event that posts.
 *
 * A reason gets a ceiling when nothing else bounds how many of it one caller
 * can produce. The shared ops queue is 50 deep, drains sequentially and drops
 * its oldest entries on overflow (`@services/alerts/ops-events`), so an
 * unbounded reason buries the verification / cashout / deposit feed under
 * identical embeds plus "N events dropped" summaries — during exactly the
 * incident the mode switch was added to survive, and making the log-only sample
 * the rollout depends on silently lossy.
 *
 * `limits-unavailable` is not a per-account fact at all: a Redis fault or a
 * price-pod outage past the 10-minute price cache makes EVERY send in flight
 * report it at the same instant. `rate-limited` and `undecodable-invoice` are
 * per-caller but unbounded — the first because a client in a retry loop keeps
 * producing it after the budget is spent, the second because it is raised
 * BEFORE the amount is knowable and therefore, on this rail, is the outcome of
 * a request the caller can repeat at will.
 *
 * `over-daily-limit` and `invalid-amount` are NOT coalesced: they are
 * per-account facts (which account, which level, what amount) that the log-only
 * rollout exists to read one by one, and each of them is raised only after the
 * caller's attempt budget has been charged, so the budget bounds them.
 *
 * Nothing is lost to coalescing that the rollout needs to count: the span
 * attributes in `report()` are emitted for every rejection of every reason,
 * unthrottled.
 */
export const OPS_EVENT_COALESCE_MS = 60_000

const COALESCED_REASONS: ReadonlySet<SendRejectionReason> = new Set([
  SendRejectionReasons.limitsUnavailable,
  // The decode gate runs on `lnInvoicePaymentSend` before the amount is
  // knowable, so it is the one rejection an authenticated caller can produce
  // from a single-field request body — `paymentRequest: "lnx"` satisfies the
  // LnPaymentRequest scalar (/^ln[a-z0-9]+$/i) and fails `decodeInvoice`. A
  // truncated QR scan retrying in a loop would otherwise post one embed per
  // HTTP request into the 50-deep FIFO. `gateSend` now charges the attempt
  // budget for these too, but the budget is 10/min per account and a handful of
  // accounts still outruns the queue; the ceiling is what bounds the feed.
  SendRejectionReasons.undecodableInvoice,
  // Coalesced, NOT silenced. A rate-limited caller is already bounded by their
  // own Redis budget, so the reason silencing was tempting — but the whole PR
  // is a log-only rollout, and a check with no observable output cannot be read
  // before flipping to enforce. An operator counting a week of would-reject
  // embeds would see no rate-limit signal by construction and conclude the
  // burst bucket never fires, then enforce and hand a 30-payment payout batch
  // twenty TooManyRequestErrors. One embed per minute carrying `muted: N`
  // bounds the 50-deep ops queue exactly as it does for limits-unavailable and
  // still yields a count.
  SendRejectionReasons.rateLimited,
])

const opsEventWindows = new Map<
  SendRejectionReason,
  { openedAt: number; muted: number }
>()

// Test-only. The windows above are per-process by design and a muted count is
// now cleared only by being delivered, so without this one test's swallowed
// events surface as another's `muted`. The spec used to lean on the staleness
// cutoff to isolate itself — and that cutoff was the bug it hid, since a short
// incident's mutes were dropped. Nothing in production calls this.
export const __resetOpsEventCoalescingForTest = (): void => {
  opsEventWindows.clear()
}

// Returns whether this rejection gets an ops event, and how many events of the
// same reason were muted since the last one that did.
const claimOpsEventSlot = (
  reason: SendRejectionReason,
): { post: false } | { post: true; muted: number; mutedWindowAgeS: number } => {
  if (!COALESCED_REASONS.has(reason)) {
    return { post: true, muted: 0, mutedWindowAgeS: 0 }
  }

  const now = Date.now()
  const lastWindow = opsEventWindows.get(reason)
  if (lastWindow && now - lastWindow.openedAt < OPS_EVENT_COALESCE_MS) {
    lastWindow.muted += 1
    return { post: false }
  }

  // Muted events are carried onto the next event that posts, however long that
  // takes. A staleness cutoff here looked tidy but silently lost the most
  // common incident shape: a 40-second Redis blip mutes 499 rejections, Redis
  // recovers, no further event of that reason arrives inside the cutoff, and
  // ops reads a feed saying one send was affected. The count is only ever
  // cleared by being delivered. `mutedWindowAgeS` dates it so a late carry is
  // legible as an older incident rather than pinned to this rejection.
  const carried = lastWindow?.muted ?? 0
  const carriedAgeS =
    carried > 0 && lastWindow ? Math.round((now - lastWindow.openedAt) / 1000) : 0

  opsEventWindows.set(reason, { openedAt: now, muted: 0 })
  return { post: true, muted: carried, mutedWindowAgeS: carriedAgeS }
}

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
 * Check 1, on its own so that `gateSend` — a rail-local rejection raised before
 * the amount is knowable — costs the caller a point exactly as a rejection
 * inside `evaluateSend` does. Exactly one of the two charges per request: a
 * request that reaches `gateSend` never reaches `authorizeSend`.
 */
const consumeAttemptBudget = async (
  senderAccount: Account,
): Promise<true | SendRejection> => {
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
  return true
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
  const budget = await consumeAttemptBudget(senderAccount)
  if (budget !== true) return budget

  // 2. amount sanity + normalisation to USD cents
  const normalised = await usdCentsFromSendAmount(amount)
  if ("error" in normalised) return normalised
  const { cents } = normalised

  // 3. daily limit for the level doubles as the per-transaction cap (Phase 0)
  const level = effectiveAccountLevel(senderAccount.level)
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

/**
 * The one span name the rejection census is queryable by.
 *
 * `addAttributesToCurrentSpan` writes to whatever span is active, and that span
 * differs by call path: on the six rails that accept an `idempotencyKey` the
 * guard runs as `withPaymentIdempotency`'s `authorize` hook, inside
 * `LockService().lockPaymentIdempotencyKey`, which
 * `wrapAsyncFunctionsToRunInSpan` turns into the active span — so the
 * attributes landed on `services.lock.lockPaymentIdempotencyKey`. With no
 * idempotency key, and on both on-chain rails, they landed on the GraphQL
 * resolver span instead. An operator scoping the go/no-go query to one span
 * name counted a fraction of the traffic, and the half that went missing was
 * the newer mobile clients that send idempotency keys — i.e. exactly the
 * traffic the flip to `enforce` is judged on.
 *
 * So the guard opens its own span and the census lands there, every rail, every
 * call path. `gateSend` shares the name deliberately: it is the same guard
 * reporting the same `sendGuard.*` attributes for the same rollout, and a
 * second span name would reintroduce the undercount for `undecodable-invoice`.
 * The entry point stays legible as `code.function`.
 *
 * Named in docs/send-guard.md, "What to count from".
 */
export const SEND_GUARD_SPAN_NAME = "app.payments.authorizeSend"

const runInGuardSpan = async <T>(entryPoint: string, fn: () => Promise<T>): Promise<T> =>
  asyncRunInSpan(
    SEND_GUARD_SPAN_NAME,
    {
      attributes: {
        [SemanticAttributes.CODE_FUNCTION]: entryPoint,
        [SemanticAttributes.CODE_NAMESPACE]: "app.payments",
      },
    },
    fn,
  )

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
  const level = effectiveAccountLevel(senderAccount.level)

  // The census the rollout is read from. Unconditional and unthrottled, unlike
  // the ops feed below: that queue is fire-and-forget, no-ops when
  // `OPS_DISCORD_WEBHOOK_URL` is unset, drops its oldest entries on overflow,
  // and coalesces the unbounded reasons — so "count them by reason before
  // flipping to enforce" cannot be answered from it alone. Counted from
  // tracing, every rejection of every reason is there exactly once.
  // Every value goes on as a STRING. `addAttributesToCurrentSpan` sets an
  // attribute only `if (value)` (src/services/tracing.ts), and
  // `AccountLevel.Zero === 0` — so a numeric level would drop the attribute for
  // exactly the cohort this rollout exists to measure (~300 unleveled prod
  // accounts, plus every genuine L0 user), and "attribute absent" means level 0
  // nowhere in the runbook.
  //
  // `cents` stays a NUMBER: it is the one field whose distribution the rollout
  // reads (step 3 decides whether to raise a level's limit from the refused
  // amounts), and a string gives neither a heatmap nor a MAX — string ordering
  // even sorts "9900" above "125000". The falsy-drop that stringifying would
  // guard against is unreachable here: cents is attached on only two paths, and
  // the over-limit one is provably `cents > limit >= 12500`.
  addAttributesToCurrentSpan({
    "sendGuard.rejection": reason,
    "sendGuard.mode": mode,
    "sendGuard.kind": kind,
    "sendGuard.level": String(level),
    "sendGuard.error": error.constructor.name,
    ...(cents === undefined ? {} : { "sendGuard.cents": cents }),
  })

  const slot = claimOpsEventSlot(reason)
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
        level: String(level),
        mode,
        // How many events of this reason were coalesced away since the last one
        // that posted, so the feed stays countable rather than silently lossy.
        ...(slot.muted > 0
          ? {
              muted: String(slot.muted),
              // How long ago the window that accumulated them opened, so a
              // count delivered late reads as an older incident.
              mutedAgeS: String(slot.mutedWindowAgeS),
            }
          : {}),
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

/**
 * For a rail-local check that is part of the guard but cannot live inside
 * `authorizeSend` — today only the bolt11 decode on `lnInvoicePaymentSend`,
 * which has to happen before the amount is even knowable.
 *
 * Without this, such a check silently ignored the mode: it returned its error
 * in `log-only` too, so a rail the docs promised was only observing refused
 * invoices IBEX would have paid, with no ops event and nothing in the
 * would-reject sample to show for it. Routing it through here gives it the
 * same switch, the same feed entry and the same rollout evidence as every
 * other check.
 *
 * It also charges the attempt budget, for the same reason `evaluateSend`
 * charges it before any other check: a rejected attempt has to cost the caller
 * a point, or the rail has a check an authenticated client can fail without
 * limit. On `lnInvoicePaymentSend` that check is reachable from a one-field
 * request body — `paymentRequest: "lnx"` passes the LnPaymentRequest scalar and
 * fails `decodeInvoice` — so before this it was the one send outcome that cost
 * nothing to produce. The budget is charged exactly once per request either
 * way: a request that reaches `gateSend` never reaches `authorizeSend`.
 *
 * An exhausted budget is reported as `rate-limited` and returned in place of
 * the rail-local error: the caller IS rate limited, and saying so is both truer
 * and the answer that stops the loop.
 */
export const gateSend = async ({
  error,
  reason,
  senderAccount,
  senderWalletId,
  kind,
}: {
  error: ApplicationError
  reason: SendRejectionReason
  senderAccount: Account
  senderWalletId: WalletId
  kind: SendKind
}): Promise<true | ApplicationError> => {
  const mode = getSendGuardMode()
  if (mode === "off") return true

  // The census, not the verdict, is what has to be inside the span: `report`
  // writes the `sendGuard.*` attributes to the active span. The mode decision
  // stays outside so an enforced rejection is not also recorded as a span
  // exception by `asyncRunInSpan`'s `instanceof Error` branch — that signal is
  // reserved for `limits-unavailable` (see `report`), and drowning it in
  // ordinary over-limit rejections is what the runbook alerts off.
  const rejection = await runInGuardSpan("gateSend", async () => {
    const budget = await consumeAttemptBudget(senderAccount)
    const rejection: SendRejection = budget === true ? { error, reason } : budget

    report({
      rejection,
      mode,
      senderAccount,
      senderWalletId,
      kind,
    })

    return rejection
  })

  return mode === "enforce" ? rejection.error : true
}

export const authorizeSend = async (
  args: AuthorizeSendArgs,
): Promise<true | ApplicationError> => {
  const mode = getSendGuardMode()
  // Off is off: no Redis round-trip, no price lookup, no ops event. A guard
  // that cannot be turned off without a deploy is a new hard dependency in
  // front of every send on every rail.
  if (mode === "off") return true

  // Same reason as `gateSend`: evaluate and report inside the guard's own span
  // so the census is queryable by one name, decide outside it so only
  // `limits-unavailable` records a span exception.
  const outcome = await runInGuardSpan("authorizeSend", async () => {
    const outcome = await evaluateSend(args)
    if (outcome === true) return true

    report({
      rejection: outcome,
      mode,
      senderAccount: args.senderAccount,
      senderWalletId: args.senderWalletId,
      kind: args.kind,
    })

    return outcome
  })
  if (outcome === true) return true

  return mode === "enforce" ? outcome.error : true
}
