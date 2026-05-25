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

export const usdCentsToUsdtMicros = (
  usdCents: string,
): string | InvalidCashWalletCutoverAmountError => {
  const parsed = parseNonNegativeInteger(usdCents)
  if (parsed instanceof Error) return parsed
  return (parsed * USDT_MICROS_PER_USD_CENT).toString()
}

export const feeUsdCentsToUsdtMicros = usdCentsToUsdtMicros

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
