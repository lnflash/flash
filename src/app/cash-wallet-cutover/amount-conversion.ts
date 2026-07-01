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

export const usdtMicrosToUsdCentsCeil = (
  usdtMicros: string,
): string | InvalidCashWalletCutoverAmountError => {
  const parsed = parseNonNegativeInteger(usdtMicros)
  if (parsed instanceof Error) return parsed
  if (parsed === 0n) return "0"
  return ((parsed + USDT_MICROS_PER_USD_CENT - 1n) / USDT_MICROS_PER_USD_CENT).toString()
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
