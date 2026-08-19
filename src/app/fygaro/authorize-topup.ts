import { AccountLevel } from "@domain/accounts"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { baseLogger } from "@services/logger"
import {
  buildCustomReference,
  buildFygaroCheckout,
  type FygaroCheckout,
} from "@services/fygaro/checkout"
import { FygaroReservationWriteError } from "@services/fygaro/errors"
import {
  newIntentId,
  readIntent,
  readOutstandingReservations,
  releaseIntentReservation,
  saveIntent,
  type FygaroReservation,
} from "@services/fygaro/checkout-intent-store"
import { getFygaroSettings } from "@services/fygaro/webhook-server/fygaro-settings"
import {
  evaluateCreditGate,
  type RecordOnlyReason,
} from "@services/fygaro/webhook-server/fees"
import { getFlashFeeDiscountPercent } from "@services/frappe/fee-discounts"
import { sumFygaroTopupGrossCentsLast24h } from "@services/frappe/BridgeTransferRequestWriter"

import { fygaroCheckoutMasterGate } from "./checkout-master-gate"

/**
 * Authorise a card top-up BEFORE the customer is sent to Fygaro.
 *
 * This is the half of the daily-limit story that was missing. The webhook has
 * always been able to refuse a credit, but by then Fygaro has captured the
 * card, so refusing leaves the customer charged and empty-handed (which is
 * exactly what happened to one account on 2026-08-16). Deciding here, before
 * the hand-off, is the only point at which "no" costs the customer nothing.
 *
 * The returned checkout URL carries a signed amount, so the answer given here
 * is the amount that can actually be paid.
 *
 * The decision itself is NOT reimplemented here: it is `evaluateCreditGate`,
 * the same function the webhook runs after the charge. Any ladder written twice
 * drifts, and every drifted gate is a customer charged for a credit that will
 * be refused.
 */

export type AuthorizeTopupFailure =
  | "checkout-disabled"
  | "settings-unavailable"
  | "below-minimum"
  | "non-positive-net"
  | "above-single-payment-limit"
  | "no-daily-limit-for-level"
  | "history-unavailable"
  // The reservation index (Redis) was unreadable. Deliberately NOT folded into
  // `history-unavailable`: that name sends the operator reading the alert to
  // ERPNext for a fault that is in Redis.
  | "reservations-unavailable"
  | "exceeds-daily-allowance"
  // The account has NOT spent its allowance — it is holding it, in links it
  // authorised and has not paid. Distinct from `exceeds-daily-allowance`
  // because telling someone who has spent $0 today that they have $0 left is
  // simply false, and the honest answer ("finish or wait for the link you
  // already have") is the one they can act on.
  | "checkout-already-open"

export type AuthorizeTopupResult =
  | {
      authorized: true
      checkout: FygaroCheckout
      remainingAllowanceCents: number
      // True when this is a link the account already held, handed back rather
      // than minted. Nothing new was reserved.
      reused?: boolean
    }
  | {
      authorized: false
      reason: AuthorizeTopupFailure
      // Present whenever we know it, so the client can say "$45 left today"
      // instead of a bare refusal. Undefined only when the allowance itself
      // could not be established.
      remainingAllowanceCents?: number
      limitCents?: number
      minimumCents?: number
      // When (and for how much) the open link that is holding the allowance
      // stops being payable. Only set for `checkout-already-open`.
      holdExpiresAt?: Date
      holdAmountCents?: number
    }

export type AuthorizeTopupRefusal = Extract<AuthorizeTopupResult, { authorized: false }>

/**
 * Every stop `evaluateCreditGate` can return, in the vocabulary this call site
 * answers in. Exhaustive by type, so a new gate reason cannot be added to the
 * webhook without a decision being made here too.
 *
 * `non-usd` and `intent-mismatch` are unreachable from this path — the currency
 * is fixed to USD and no payment exists yet — but map to the same "we cannot
 * offer you a checkout" answer rather than being asserted away.
 */
const FAILURE_BY_GATE_REASON: Record<RecordOnlyReason, AuthorizeTopupFailure> = {
  "credit-disabled": "checkout-disabled",
  "auto-credit-disabled": "checkout-disabled",
  "non-usd": "checkout-disabled",
  "intent-mismatch": "checkout-disabled",
  "settings-unavailable": "settings-unavailable",
  "history-unavailable": "history-unavailable",
  "over-limit": "above-single-payment-limit",
  "no-daily-limit-for-level": "no-daily-limit-for-level",
  "daily-limit-exceeded": "exceeds-daily-allowance",
  "non-positive-net": "non-positive-net",
  "under-minimum": "below-minimum",
}

export const authorizeFygaroTopup = async ({
  accountId,
  username,
  level,
  amountCents,
  nowMs = Date.now(),
}: {
  accountId: string
  username: string
  level: AccountLevel
  amountCents: number
  nowMs?: number
}): Promise<AuthorizeTopupResult> => {
  // The yaml master gates come first, before any ERPNext read: with any of them
  // off, a payment made against a link minted here is either never RECORDED
  // (`fygaro.enabled`), recorded and never credited (`credit.enabled`), or
  // impossible to sign at all (`checkout.*`) — the customer charged and
  // uncredited, which is the failure this whole path exists to prevent.
  //
  // Shared with `getFygaroTopupAllowance` rather than restated, so the surface
  // that REPORTS an allowance and the surface that GRANTS one cannot disagree
  // about whether checkout is on. The gate hands back the config it checked,
  // so the link below is signed with exactly the values that passed it.
  const master = fygaroCheckoutMasterGate()
  if (!master.ok) {
    return { authorized: false, reason: master.reason }
  }
  // True by construction past the gate above — `credit.enabled` is one of the
  // four switches it refuses on. Named rather than inlined because
  // `evaluateCreditGate` takes it as a parameter and reading `true` at the call
  // site says nothing about why.
  const creditEnabled = true

  // Returns undefined (never throws) when the ERPNext row is unreadable or
  // malformed — same "record-only" posture the webhook takes.
  const settings = await getFygaroSettings()

  const minimumCents =
    settings === undefined ? undefined : Math.round(settings.minimumTopup * 100)
  const singleLimitCents =
    settings === undefined ? undefined : Math.round(settings.autoCreditLimit * 100)
  const dailyLimitUsd = settings?.dailyTopupLimits[level]
  const dailyLimitCents =
    dailyLimitUsd === undefined ? undefined : Math.round(dailyLimitUsd * 100)

  const refuseWith = (
    reason: AuthorizeTopupFailure,
    remainingAllowanceCents?: number,
    limitCents?: number,
  ): AuthorizeTopupRefusal => ({
    authorized: false,
    reason,
    remainingAllowanceCents,
    limitCents: limitCents ?? dailyLimitCents,
    minimumCents,
  })

  const refuse = (
    reason: RecordOnlyReason,
    remainingAllowanceCents?: number,
  ): AuthorizeTopupRefusal =>
    refuseWith(
      FAILURE_BY_GATE_REASON[reason],
      remainingAllowanceCents,
      reason === "over-limit" ? singleLimitCents : dailyLimitCents,
    )

  /**
   * Refuse a request because a dependency of the CHECK is down, and page for it.
   *
   * The webhook side pages on both of its transient stops (payment.ts). This
   * side had no signal at all, so card top-ups could be 100% unavailable for
   * every user while nothing fired. The dedup key is static per reason: an
   * outage is one incident, not one per refused customer, and naming the reason
   * in the key keeps "ERPNext is down" from masquerading as "Redis is down".
   */
  const refuseTransient = (
    reason: "settings-unavailable" | "history-unavailable" | "reservations-unavailable",
  ): AuthorizeTopupRefusal => {
    alertBridge({
      dedupKey: generateDedupKey.fygaroAuthorizeUnavailable(reason),
      source: "fygaro-checkout",
      severity: "warning",
      title: "Fygaro pre-charge allowance check unavailable — card top-ups refusing",
      detail: `reason=${reason}`,
      context: { reason, account_id: accountId },
    })
    return refuseWith(reason)
  }

  /**
   * The account is HOLDING its allowance, not spending it.
   *
   * First choice is to give it back: if one of the live holds is for exactly
   * this amount, the customer is asking for the link they already have, so hand
   * that link back rather than refusing them for their own reservation. Nothing
   * new is reserved and the outstanding total does not move.
   *
   * Failing that (a different amount, or a record from before the URL was
   * stored), refuse with a reason that says what is actually true and when the
   * hold lifts.
   */
  const refuseOpenCheckout = async ({
    reservations,
    amountCents,
    dailyLimitCents,
    remainingAllowanceCents,
  }: {
    reservations: FygaroReservation[]
    amountCents: number
    dailyLimitCents: number
    // How much MORE could be authorised right now — live holds already
    // subtracted. In the canonical abandoned-link case this is 0, and that is
    // the true answer to "what else can I do this second": nothing, until the
    // hold lifts. It is not a claim about what the account has spent, which is
    // why `holdAmountCents`/`holdExpiresAt` travel with it and why the field's
    // schema description says outright that holds count against it.
    remainingAllowanceCents: number
  }): Promise<AuthorizeTopupResult> => {
    const sameAmount = reservations.find((r) => r.amountCents === amountCents)
    if (sameAmount) {
      const open = await readIntent(sameAmount.intentId)
      if (
        open.found &&
        // Belt and braces: the id came out of THIS account's reservation index,
        // so a record naming another account means the two disagree and the
        // link is not ours to hand out.
        open.intent.accountId === accountId &&
        // A record carrying ANY outcome has been paid against. The record
        // deliberately outlives redemption now (the status poll reads it), so
        // "the record still exists" no longer implies "nobody has used this
        // link" — that inference has to be made explicitly, or a redemption
        // whose zrem failed would see the link handed back to a customer who
        // has already been charged for it. `received` counts as much as the
        // terminal states do: it means the webhook has SEEN a payment against
        // this authorisation, which is precisely when re-offering the link
        // would invite the customer to pay it a second time.
        open.intent.outcome === undefined &&
        open.intent.checkoutUrl !== undefined &&
        open.intent.expiresAtMs !== undefined &&
        open.intent.expiresAtMs > nowMs
      ) {
        baseLogger.info(
          { accountId, intentId: sameAmount.intentId },
          "Re-offering the Fygaro checkout link this account already holds",
        )
        return {
          authorized: true,
          reused: true,
          checkout: {
            url: open.intent.checkoutUrl,
            expiresAt: new Date(open.intent.expiresAtMs),
            customReference: buildCustomReference({
              username: open.intent.username,
              intentId: open.intent.intentId,
            }),
            // The re-offered link is the SAME authorisation, so it must poll
            // under the same id — a fresh one would report "processing"
            // forever against an intent no payment will ever reference.
            intentId: open.intent.intentId,
          },
          // The hold is already counted, so nothing is subtracted a second
          // time for handing the same link back.
          remainingAllowanceCents,
        }
      }
    }

    // The soonest hold to lift is the soonest moment more allowance exists, so
    // that — not the latest — is the time worth telling the customer.
    const soonest = reservations.reduce(
      (earliest: FygaroReservation | undefined, r) =>
        earliest === undefined || r.expiresAtMs < earliest.expiresAtMs ? r : earliest,
      undefined,
    )
    return {
      ...refuseWith("checkout-already-open", remainingAllowanceCents, dailyLimitCents),
      holdExpiresAt: soonest ? new Date(soonest.expiresAtMs) : undefined,
      holdAmountCents: soonest?.amountCents,
    }
  }

  const gateArgs = {
    creditEnabled,
    currency: "USD",
    settings,
    grossCents: amountCents,
    level,
  }

  // Probe with an unknown history: `history-unavailable` is the FIRST gate that
  // needs one, so any other stop is decided without reading ERPNext at all — a
  // client can no longer make us run a list query per rejected amount. The
  // ordering lives in evaluateCreditGate; this reads it rather than restating it.
  const probe = evaluateCreditGate({ ...gateArgs, priorDayGrossCents: undefined })
  if (!probe.credit && probe.reason !== "history-unavailable") {
    if (probe.reason === "settings-unavailable") {
      return refuseTransient("settings-unavailable")
    }
    return refuse(probe.reason)
  }

  const priorCents = await sumFygaroTopupGrossCentsLast24h({ accountId })
  if (priorCents instanceof Error) {
    // Never coerce an unreadable history to zero: that would treat an ERPNext
    // outage as a clean slate and authorise the full allowance to everyone.
    return refuseTransient("history-unavailable")
  }

  // Authorisation is only a promise until it is also a reservation. Links this
  // account already holds are money it can still spend, so they count against
  // the allowance exactly like settled charges do — otherwise N calls each mint
  // a full-allowance link and paying two of them strands the second.
  const reservations = await readOutstandingReservations({ accountId, nowMs })
  if (reservations instanceof Error) {
    // Same posture as the history read: unknown outstanding is not zero
    // outstanding. The customer is told we could not check, not that they are
    // over a limit we never measured — and the reason names REDIS, so nobody
    // goes hunting through ERPNext for it.
    return refuseTransient("reservations-unavailable")
  }
  const outstandingCents = reservations.reduce((sum, r) => sum + r.amountCents, 0)

  // Fail-open (0 on any failure), and gross-denominated gates are discount-blind
  // anyway — it only moves the fee math, which is what `non-positive-net` turns
  // on. Read here so this side and the webhook side compute the same net.
  const flashFeeDiscountPercent = await getFlashFeeDiscountPercent({
    username,
    flow: "topup",
  })

  const spentCents = priorCents + outstandingCents
  const remainingAllowanceCents =
    dailyLimitCents === undefined ? undefined : Math.max(0, dailyLimitCents - spentCents)

  const gate = evaluateCreditGate({
    ...gateArgs,
    priorDayGrossCents: spentCents,
    flashFeeDiscountPercent,
  })
  if (!gate.credit) {
    // Settled spend and live holds are both "gone" as far as the cap is
    // concerned, but they are NOT the same thing to the customer. When the
    // shortfall is entirely this account's own unpaid links — the single most
    // common thing a payer does is open a payment page and abandon it — the
    // honest answers are, in order: hand them the link they already have, or
    // tell them when it expires. Telling someone who has spent nothing today
    // that they have $0.00 left is false, and their natural response (retry
    // immediately) is exactly what keeps hitting it.
    if (
      gate.reason === "daily-limit-exceeded" &&
      dailyLimitCents !== undefined &&
      priorCents + amountCents <= dailyLimitCents
    ) {
      return refuseOpenCheckout({
        reservations,
        amountCents,
        dailyLimitCents,
        remainingAllowanceCents: remainingAllowanceCents ?? 0,
      })
    }
    return refuse(gate.reason, remainingAllowanceCents)
  }

  // Past this point the gate said yes, so the daily limit exists by construction
  // (`no-daily-limit-for-level` precedes it) — narrowed for the type checker.
  const allowanceCents = remainingAllowanceCents ?? 0

  const intentId = newIntentId()
  const checkout = buildFygaroCheckout({
    buttonUrl: master.buttonUrl,
    username,
    intentId,
    amountCents,
    currency: "USD",
    keyId: master.keyId,
    secret: master.secret,
    ttlSeconds: master.ttlSeconds,
    nowMs,
  })

  const intent = {
    intentId,
    accountId,
    username,
    amountCents,
    currency: "USD",
    createdAtMs: nowMs,
    // Stored so an abandoned checkout can be re-offered instead of refused by
    // its own hold. The URL is already in the customer's hands at this point,
    // so keeping a copy adds no exposure the payment page does not already have.
    checkoutUrl: checkout.url,
    expiresAtMs: checkout.expiresAt.getTime(),
  }
  const saved = await saveIntent({ intent, ttlSeconds: master.ttlSeconds })
  if (saved instanceof FygaroReservationWriteError) {
    // The hold could not be recorded, so the next request would see this
    // allowance as still free and hand it out again — the over-issue the
    // reservation exists to stop. The read side of the same index already
    // refuses when it is unreachable; the write side has to match, or the
    // guarantee only holds while Redis is healthy.
    return refuseTransient("reservations-unavailable")
  }
  if (saved instanceof Error) {
    // Only the after-the-fact CROSS-CHECK RECORD is missing. The signed URL is
    // still perfectly payable and the webhook's own credit gate still applies
    // in full, so proceeding here is the same unverified-legacy position every
    // pre-intent payment is in — not a reason to refuse a legitimate top-up.
    //
    // This branch is safe ONLY because `saveIntent` writes the reservation
    // before the record (see the ordering note there). Any error that reaches
    // here is therefore a record/claim failure with the hold already in Redis;
    // a reservation that could not be written cannot reach this line at all —
    // it returns FygaroReservationWriteError and is refused above. If that
    // ordering is ever reversed, this branch starts authorising links against
    // an allowance nothing is holding, and must become a refusal instead.
    baseLogger.warn(
      { intentId, error: saved.constructor.name },
      "Failed to persist the Fygaro cross-check record; proceeding on the credit gate alone",
    )
    // Deliberately NOT an early return. The hold is real, so this request has
    // to be treated like every other authorised one from here down: it must go
    // through the post-reserve concurrency re-read (a racing request holds
    // allowance this one has not seen), and it must report the allowance NET of
    // its own reservation. Returning here reported the pre-reservation figure,
    // which now overstates the headroom by exactly this request's amount.
  }

  // Reserve, then re-read. Two requests that raced past the check above have
  // both reserved by now, so both see the combined total here and both back
  // out: the allowance can be under-used for one round trip, never over-issued.
  const after = await readOutstandingReservations({ accountId, nowMs })
  const outstandingAfter =
    after instanceof Error ? after : after.reduce((sum, r) => sum + r.amountCents, 0)
  if (
    dailyLimitCents !== undefined &&
    !(outstandingAfter instanceof Error) &&
    priorCents + outstandingAfter > dailyLimitCents
  ) {
    await releaseIntentReservation(intent)
    baseLogger.info(
      { accountId, intentId },
      "Concurrent Fygaro checkout authorisation would exceed the daily allowance; rolled back",
    )
    // `remainingAllowanceCents` was computed from the FIRST read — the read
    // this branch has just been told was stale. Reporting it here hands the
    // client a bigger number than reality in exactly the case where it is
    // wrong, so it retries the same amount and fails again. `outstandingAfter`
    // includes this request's own reservation, which the line above just
    // released, so it comes back out.
    const remainingAfterRollback = Math.max(
      0,
      dailyLimitCents - priorCents - (outstandingAfter - amountCents),
    )
    return {
      authorized: false,
      reason: "exceeds-daily-allowance",
      remainingAllowanceCents: remainingAfterRollback,
      limitCents: dailyLimitCents,
    }
  }

  return {
    authorized: true,
    checkout,
    remainingAllowanceCents: allowanceCents - amountCents,
  }
}
