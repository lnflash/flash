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
 * flash_fee_cents      = round(gross * pct/100) + round(fixed * 100)
 * net_cents            = gross - processor_fee - flash_fee
 */
export const computeFygaroFees = ({
  grossCents,
  settings,
}: {
  grossCents: number
  settings: FeeSettings
}): FygaroFees => {
  const processorFeeCents =
    Math.round((grossCents * settings.processorFeePercent) / 100) +
    Math.round(settings.processorFeeFixed * 100)
  const flashFeeCents =
    Math.round((grossCents * settings.flashMarginPercent) / 100) +
    Math.round(settings.flashMarginFixed * 100)
  const netCents = grossCents - processorFeeCents - flashFeeCents

  return { grossCents, processorFeeCents, flashFeeCents, netCents }
}

// Why a payment was NOT auto-credited. `credit-disabled` is the deploy-level
// master gate (FygaroConfig.credit.enabled) and is handled silently; the rest
// are runtime conditions worth an ops alert because credit IS supposed to be on.
export type RecordOnlyReason =
  | "credit-disabled"
  | "settings-unavailable"
  | "auto-credit-disabled"
  | "non-usd"
  | "over-limit"
  | "under-minimum"
  | "non-positive-net"

export type CreditGate =
  | { credit: true; fees: FygaroFees }
  | { credit: false; reason: RecordOnlyReason }

/**
 * Auto-credit runs ONLY if every gate holds, evaluated in this order:
 *   1. credit enabled at deploy level (FygaroConfig.credit.enabled)
 *   2. Fygaro Settings available AND auto_credit_enabled
 *   3. currency === "USD"
 *   4. gross <= auto_credit_limit (inclusive upper bound on GROSS)
 *   5. net > 0 (after fees)
 *   6. gross >= minimum_topup (inclusive lower bound on GROSS)
 * The first failing gate names the record-only reason.
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
}: {
  creditEnabled: boolean
  currency: string
  settings: FygaroSettings | undefined
  grossCents: number
}): CreditGate => {
  if (!creditEnabled) return { credit: false, reason: "credit-disabled" }
  if (!settings) return { credit: false, reason: "settings-unavailable" }
  if (!settings.autoCreditEnabled)
    return { credit: false, reason: "auto-credit-disabled" }
  if (currency !== "USD") return { credit: false, reason: "non-usd" }
  if (grossCents > Math.round(settings.autoCreditLimit * 100)) {
    return { credit: false, reason: "over-limit" }
  }

  const fees = computeFygaroFees({ grossCents, settings })
  if (fees.netCents <= 0) return { credit: false, reason: "non-positive-net" }
  if (grossCents < Math.round(settings.minimumTopup * 100)) {
    return { credit: false, reason: "under-minimum" }
  }

  return { credit: true, fees }
}
