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
  | "non-positive-net"

export type CreditGate =
  | { credit: true; fees: FygaroFees }
  | { credit: false; reason: RecordOnlyReason }

/**
 * Auto-credit runs ONLY if every gate holds, evaluated in this order:
 *   1. credit enabled at deploy level (FygaroConfig.credit.enabled)
 *   2. Fygaro Settings available AND auto_credit_enabled
 *   3. currency === "USD"
 *   4. gross <= auto_credit_limit (threshold on GROSS)
 *   5. net > 0 (after fees)
 * The first failing gate names the record-only reason.
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

  return { credit: true, fees }
}
