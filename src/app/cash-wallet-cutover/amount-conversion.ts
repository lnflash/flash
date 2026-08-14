import { InvalidCashWalletCutoverAmountError } from "./errors"

const USDT_MICROS_PER_USD_CENT = 10_000n

const parseNonNegativeInteger = (
  value: string,
): bigint | InvalidCashWalletCutoverAmountError => {
  if (!/^\d+$/.test(value)) {
    return new InvalidCashWalletCutoverAmountError(
      `Invalid non-negative integer amount: ${value}`,
    )
  }
  return BigInt(value)
}

const decimalToScaledInteger = ({
  value,
  scale,
}: {
  value: string
  scale: number
}): string | InvalidCashWalletCutoverAmountError => {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return new InvalidCashWalletCutoverAmountError(
      `Invalid non-negative decimal amount: ${value}`,
    )
  }

  const [whole, fraction = ""] = value.split(".")
  const scaleFactor = 10n ** BigInt(scale)
  const paddedFraction = `${fraction}${"0".repeat(scale + 1)}`.slice(0, scale + 1)
  const scaledFraction = paddedFraction.slice(0, scale)
  const roundingDigit = Number(paddedFraction[scale] ?? "0")

  const scaled =
    BigInt(whole) * scaleFactor + BigInt(scaledFraction === "" ? "0" : scaledFraction)

  return (scaled + (roundingDigit >= 5 ? 1n : 0n)).toString()
}

export const usdCentsToUsdtMicros = (
  usdCents: string,
): string | InvalidCashWalletCutoverAmountError => {
  return decimalToScaledInteger({ value: usdCents, scale: 4 })
}

/**
 * USDT micros → USD cents for BALANCE REPORTING, preserving the fraction
 * (1 cent = 10,000 micros, so ≤4 decimal places).
 *
 * Rounding here — the old `asUsdCents()` toFixed(0), half-to-even — reported
 * up to half a cent MORE than the wallet holds, so a client that sent the
 * reported balance died at IBEX with "insufficient balance" (on-device repro:
 * 1,099,346 micros reported as 110 cents; true balance 109.9346). The wallet
 * `balance` GraphQL field is FractionalCentAmount; clients floor for
 * spendable-amount decisions.
 *
 * The amount is SIGNED: FractionalCentAmount is documented "can be positive
 * or negative", Money holds negatives, and IBEX can report a small negative
 * balance (fee reconciliation / ledger anomaly). A leading "-" negates the
 * result — it must not error, or the wallet's balance field breaks on every
 * query.
 *
 * Returns InvalidCashWalletCutoverAmountError on malformed input (module
 * convention) — callers are GraphQL resolvers that `throw mapError(err)`
 * like their other error paths.
 */
export const usdtMicrosToUsdCents = (
  usdtMicros: bigint | number | string,
): number | InvalidCashWalletCutoverAmountError => {
  const [wholeMicros, fractionalMicros] = usdtMicros.toString().split(".")
  if (fractionalMicros && !/^0+$/.test(fractionalMicros)) {
    return new InvalidCashWalletCutoverAmountError(
      `Cannot convert fractional USDT micros ${usdtMicros} to USD cents`,
    )
  }

  const negative = wholeMicros.startsWith("-")
  const magnitude = parseNonNegativeInteger(negative ? wholeMicros.slice(1) : wholeMicros)
  if (magnitude instanceof Error) {
    return new InvalidCashWalletCutoverAmountError(
      `Invalid USDT micros amount: ${usdtMicros}`,
    )
  }

  const wholeCents = magnitude / USDT_MICROS_PER_USD_CENT
  const fracMicros = magnitude % USDT_MICROS_PER_USD_CENT
  const cents = Number(`${wholeCents}.${fracMicros.toString().padStart(4, "0")}`)
  return negative && cents !== 0 ? -cents : cents
}

export const usdtMicrosToUsdCentsCeil = (
  usdtMicros: string,
): string | InvalidCashWalletCutoverAmountError => {
  const parsed = parseNonNegativeInteger(usdtMicros)
  if (parsed instanceof Error) return parsed
  if (parsed === 0n) return "0"
  return ((parsed + USDT_MICROS_PER_USD_CENT - 1n) / USDT_MICROS_PER_USD_CENT).toString()
}

// Rollback (ENG-401): how much USD (expressed in USDT micros so it can be
// paid with a sender-side USDT amount) the legacy wallet is still missing
// versus the balance the account originally migrated with. Both inputs are
// precise-cent decimal strings (up to 6 decimal places, as produced by
// ibexUsdDollarsToPreciseCents).
export const legacyShortfallUsdtMicros = ({
  sourceUsdCents,
  currentUsdCents,
}: {
  sourceUsdCents: string
  currentUsdCents: string
}): string | InvalidCashWalletCutoverAmountError => {
  const source = usdCentsToUsdtMicros(sourceUsdCents)
  if (source instanceof Error) return source
  const current = usdCentsToUsdtMicros(currentUsdCents)
  if (current instanceof Error) return current

  const sourceMicros = BigInt(source)
  const currentMicros = BigInt(current)
  if (currentMicros >= sourceMicros) return "0"
  return (sourceMicros - currentMicros).toString()
}

export const destinationShortfallUsdtMicros = ({
  targetUsdtMicros,
  startingUsdtMicros,
  currentUsdtMicros,
}: {
  targetUsdtMicros: string
  startingUsdtMicros: string
  currentUsdtMicros: string
}): string | InvalidCashWalletCutoverAmountError => {
  const target = parseNonNegativeInteger(targetUsdtMicros)
  if (target instanceof Error) return target
  const starting = parseNonNegativeInteger(startingUsdtMicros)
  if (starting instanceof Error) return starting
  const current = parseNonNegativeInteger(currentUsdtMicros)
  if (current instanceof Error) return current

  const received = current > starting ? current - starting : 0n
  if (received >= target) return "0"
  return (target - received).toString()
}
