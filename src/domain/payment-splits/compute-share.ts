import { WalletCurrency } from "@domain/shared"

const MINOR_UNITS_PER_MAJOR: Record<string, bigint> = {
  [WalletCurrency.Usd]: 100n, // cents
  [WalletCurrency.Usdt]: 1_000_000n, // micros
}

// Minor units per US cent: the send API (usdWalletAmountFromInput) takes cents.
const MINOR_UNITS_PER_CENT: Record<string, bigint> = {
  [WalletCurrency.Usd]: 1n,
  [WalletCurrency.Usdt]: 10_000n,
}

export type SplitShare =
  | { status: "ok"; triggerAmountMinor: string; shareCents: number }
  | { status: "skipped_min"; triggerAmountMinor: string; shareCents: number }

export const isSplitCurrency = (currency: string): boolean =>
  currency === WalletCurrency.Usd || currency === WalletCurrency.Usdt

/**
 * The share of an incoming payment one split rule pays out, in whole US cents.
 *
 * `amount` is the receive amount in major units as IBEX reports it (dollars for
 * USD, USDT for USDT). It is converted to minor units the same way the receive
 * notification does (on-receive.ts toPaymentAmount), the percentage is floored
 * in minor units, and the result is floored again to whole cents. Every
 * rounding step rounds the share DOWN, so the splits of one receive can never
 * add up to more than the receive itself.
 */
export const computeShare = ({
  amount,
  currency,
  percent,
  minShareCents,
}: {
  amount: number
  currency: string
  percent: number
  minShareCents: number
}): SplitShare | Error => {
  const perMajor = MINOR_UNITS_PER_MAJOR[currency]
  const perCent = MINOR_UNITS_PER_CENT[currency]
  if (perMajor === undefined || perCent === undefined) {
    return new Error(`Unsupported split currency: ${currency}`)
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return new Error(`Invalid split trigger amount: ${amount}`)
  }
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    return new Error(`Invalid split percent: ${percent}`)
  }

  const triggerMinor = BigInt(Math.round(amount * Number(perMajor)))
  const shareMinor = (triggerMinor * BigInt(percent)) / 100n
  const shareCents = Number(shareMinor / perCent)
  const triggerAmountMinor = triggerMinor.toString()

  if (shareCents < minShareCents) {
    return { status: "skipped_min", triggerAmountMinor, shareCents }
  }
  return { status: "ok", triggerAmountMinor, shareCents }
}
