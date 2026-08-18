/**
 * Fygaro top-up fee math and the auto-credit gate.
 *
 * Fygaro / PayPal take a processor cut off the gross face value before it
 * settles to Flash, and Flash keeps a configurable margin. Crediting the gross
 * (as the pre-fix webhook did) loses money on every top-up. These helpers turn
 * the operator-tuned Fygaro Settings into the NET cents to credit.
 *
 * Everything is done in integer cents; each individual fee component is rounded
 * to the nearest cent before subtraction, so the numbers reconcile exactly with
 * what an operator computes by hand from the settings.
 */
import type { FygaroSettings } from "./fygaro-settings"

export type FygaroFees = {
  grossCents: number
  processorFeeCents: number
  flashFeeCents: number
  netCents: number
}

type FeeSettings = Pick<
  FygaroSettings,
  "processorFeePercent" | "processorFeeFixed" | "flashMarginPercent" | "flashMarginFixed"
>

/**
 * gross_cents          = round(amount * 100)                          (caller supplies)
 * processor_fee_cents  = round(gross * pct/100) + round(fixed * 100)
 * flash_fee_cents      = round((round(gross * pct/100) + round(fixed * 100))
 *                              * (1 - discount/100))
 * net_cents            = gross - processor_fee - flash_fee
 *
 * `flashFeeDiscountPercent` (0-100, from the operator's Fee Discount
 * whitelist) discounts the WHOLE Flash fee — percent and fixed components —
 * never the processor fee, which is money PayPal already took. 100 waives the
 * Flash fee entirely. Out-of-range values are clamped so a garbage discount
 * can never inflate the fee or push the net above gross-minus-processor.
 */
export const computeFygaroFees = ({
  grossCents,
  settings,
  flashFeeDiscountPercent = 0,
}: {
  grossCents: number
  settings: FeeSettings
  flashFeeDiscountPercent?: number
}): FygaroFees => {
  const processorFeeCents =
    Math.round((grossCents * settings.processorFeePercent) / 100) +
    Math.round(settings.processorFeeFixed * 100)
  const fullFlashFeeCents =
    Math.round((grossCents * settings.flashMarginPercent) / 100) +
    Math.round(settings.flashMarginFixed * 100)
  const discount = Math.min(100, Math.max(0, flashFeeDiscountPercent))
  const flashFeeCents = Math.round((fullFlashFeeCents * (100 - discount)) / 100)
  const netCents = grossCents - processorFeeCents - flashFeeCents

  return { grossCents, processorFeeCents, flashFeeCents, netCents }
}

// Why a payment was NOT auto-credited. `credit-disabled` is the deploy-level
// master gate (FygaroConfig.credit.enabled) and is handled silently; the rest
// are runtime conditions worth an ops alert because credit IS supposed to be on.
// `settings-unavailable` and `history-unavailable` are TRANSIENT (an ERPNext
// blip) — the route answers 500 so the provider retries and the read
// self-heals; every other reason is deterministic and acks 200.
export type RecordOnlyReason =
  | "credit-disabled"
  | "settings-unavailable"
  | "auto-credit-disabled"
  | "non-usd"
  | "over-limit"
  | "no-daily-limit-for-level"
  | "history-unavailable"
  | "daily-limit-exceeded"
  | "under-minimum"
  | "non-positive-net"
  // The payment did not match the checkout we signed for it. Not reachable
  // from user input — the amount is inside the JWT — so it means a bug or a
  // replay on our side, and crediting anyway would be crediting something we
  // cannot account for.
  | "intent-mismatch"

export type CreditGate =
  | { credit: true; fees: FygaroFees }
  | { credit: false; reason: RecordOnlyReason }

/**
 * Auto-credit runs ONLY if every gate holds, evaluated in this order:
 *   1. credit enabled at deploy level (FygaroConfig.credit.enabled)
 *   2. Fygaro Settings available AND auto_credit_enabled
 *   3. currency === "USD"
 *   4. gross <= auto_credit_limit (inclusive upper bound on GROSS)
 *   5. the account level has a configured daily limit, the trailing-24h
 *      history read succeeded, and gross + prior-24h gross <= that limit
 *      (inclusive: a payment landing exactly ON the cap still credits)
 *   6. net > 0 (after fees)
 *   7. gross >= minimum_topup (inclusive lower bound on GROSS)
 * The first failing gate names the record-only reason.
 *
 * The daily-limit gates count GROSS captured fiat (Fiat Received + Completed
 * rows), not net credits: the cap answers "how much card volume may this user
 * run per day", and gross is also the only number the client can reproduce
 * locally to warn before charging the card.
 *
 * `under-minimum` is checked last (after the net gate) on purpose: a payment
 * below the operator minimum is a valid, positive-net, in-limit USD top-up that
 * is simply too small to auto-credit, so it records for manual handling. A
 * payment whose fees already sink the net non-positive surfaces as
 * `non-positive-net` (the more fundamental problem) rather than `under-minimum`.
 * Both bounds on gross are inclusive: exactly at the limit or exactly at the
 * minimum still auto-credits.
 */
export const evaluateCreditGate = ({
  creditEnabled,
  currency,
  settings,
  grossCents,
  level,
  priorDayGrossCents,
  flashFeeDiscountPercent = 0,
}: {
  creditEnabled: boolean
  currency: string
  settings: FygaroSettings | undefined
  grossCents: number
  // The recipient account's AccountLevel (0-3).
  level: number
  // Gross cents this account was charged over the trailing 24h (excluding the
  // current payment), or undefined when the history read failed.
  priorDayGrossCents: number | undefined
  // Flash-fee discount for this account from the Fee Discount whitelist
  // (0-100; 0 for everyone not on it). Only shifts the fee math — every
  // gross-denominated gate (limits, minimum) is discount-blind by design.
  flashFeeDiscountPercent?: number
}): CreditGate => {
  if (!creditEnabled) return { credit: false, reason: "credit-disabled" }
  if (!settings) return { credit: false, reason: "settings-unavailable" }
  if (!settings.autoCreditEnabled)
    return { credit: false, reason: "auto-credit-disabled" }
  if (currency !== "USD") return { credit: false, reason: "non-usd" }
  if (grossCents > Math.round(settings.autoCreditLimit * 100)) {
    return { credit: false, reason: "over-limit" }
  }

  const dailyLimitUsd = settings.dailyTopupLimits[level]
  if (dailyLimitUsd === undefined) {
    // No configured allowance for this level (level 0, or a future level the
    // settings row does not know) — fail closed to manual review.
    return { credit: false, reason: "no-daily-limit-for-level" }
  }
  if (priorDayGrossCents === undefined) {
    return { credit: false, reason: "history-unavailable" }
  }
  if (grossCents + priorDayGrossCents > Math.round(dailyLimitUsd * 100)) {
    return { credit: false, reason: "daily-limit-exceeded" }
  }

  const fees = computeFygaroFees({ grossCents, settings, flashFeeDiscountPercent })
  if (fees.netCents <= 0) return { credit: false, reason: "non-positive-net" }
  if (grossCents < Math.round(settings.minimumTopup * 100)) {
    return { credit: false, reason: "under-minimum" }
  }

  return { credit: true, fees }
}
