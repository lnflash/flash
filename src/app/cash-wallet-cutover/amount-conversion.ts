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
