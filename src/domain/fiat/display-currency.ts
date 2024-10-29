import { safeBigInt, WalletCurrency } from "@domain/shared"

export const CENTS_PER_USD = 100

export const SAT_PRICE_PRECISION_OFFSET = 12
export const USD_PRICE_PRECISION_OFFSET = 6
export const BTC_PRICE_PRECISION_OFFSET = 4

export const MajorExponent = {
  STANDARD: 2,
  ZERO: 0,
  ONE: 1,
  THREE: 3,
  FOUR: 4,
} as const

export const majorToMinorUnit = ({
  amount,
  displayCurrency,
}: {
  amount: number | bigint
  displayCurrency: DisplayCurrency
}): number => {
  const displayMajorExponent = getCurrencyMajorExponent(displayCurrency)
  return Number(amount) * 10 ** displayMajorExponent
}

export const getCurrencyMajorExponent = (
  currency: DisplayCurrency,
): CurrencyMajorExponent => {
  try {
    const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency })
    const { minimumFractionDigits } = formatter.resolvedOptions()
    switch (minimumFractionDigits) {
      case 0:
        return MajorExponent.ZERO
      case 1:
        return MajorExponent.ONE
      case 3:
        return MajorExponent.THREE
      case 4:
        return MajorExponent.FOUR
      default:
        return MajorExponent.STANDARD
    }
  } catch {
    // this is necessary for non-standard currencies
    return MajorExponent.STANDARD
  }
}

const displayMinorToMajor = ({
  amountInMinor,
  displayMajorExponent,
}: {
  amountInMinor: bigint
  displayMajorExponent: CurrencyMajorExponent
}) => (Number(amountInMinor) / 10 ** displayMajorExponent).toFixed(displayMajorExponent)

export const displayAmountFromNumber = <T extends DisplayCurrency>({
  amount,
  currency,
}: {
  amount: number
  currency: T
}): DisplayAmount<T> | ValidationError => {
  const amountInMinor = safeBigInt(amount)
  if (amountInMinor instanceof Error) return amountInMinor

  const displayMajorExponent = getCurrencyMajorExponent(currency)

  return {
    amountInMinor,
    currency,
    displayInMajor: displayMinorToMajor({ amountInMinor, displayMajorExponent }),
  }
}

export const displayAmountFromWalletAmount = <D extends DisplayCurrency>(
  walletAmount: PaymentAmount<WalletCurrency>,
): DisplayAmount<D> => {
  const { amount: amountInMinor, currency } = walletAmount

  const displayMajorExponent = getCurrencyMajorExponent(currency as D)

  return {
    amountInMinor,
    currency: currency as D,
    displayInMajor: displayMinorToMajor({ amountInMinor, displayMajorExponent }),
  }
}

export const priceAmountFromNumber = <
  S extends WalletCurrency,
  T extends DisplayCurrency,
>({
  priceOfOneSatInMinorUnit,
  displayCurrency,
  walletCurrency,
}: {
  priceOfOneSatInMinorUnit: number
  displayCurrency: T
  walletCurrency: S
}): WalletMinorUnitDisplayPrice<S, T> => {
  const offset =
    walletCurrency === WalletCurrency.Btc
      ? SAT_PRICE_PRECISION_OFFSET
      : USD_PRICE_PRECISION_OFFSET

  return {
    base: BigInt(Math.floor(priceOfOneSatInMinorUnit * 10 ** offset)),
    offset: BigInt(offset),
    displayCurrency,
    walletCurrency,
  }
}

export const priceAmountFromDisplayPriceRatio = <
  S extends WalletCurrency,
  T extends DisplayCurrency,
>(
  displayPriceRatio: DisplayPriceRatio<S, T>,
): WalletMinorUnitDisplayPrice<S, T> =>
  priceAmountFromNumber({
    priceOfOneSatInMinorUnit: displayPriceRatio.displayMinorUnitPerWalletUnit(),
    displayCurrency: displayPriceRatio.displayCurrency,
    walletCurrency: displayPriceRatio.walletCurrency,
  })

// TODO: GET currency symbols from Price server (listCurrencies)
export class CurrencyFormatter<T extends DisplayCurrency> {
  constructor(private displayAmount: DisplayAmount<T>) {}

  // Ideally, currency list would be static and not require loading
  toString(): string {
    const exponent = getCurrencyMajorExponent(this.displayAmount.currency) 
    return formatCurrencyHelper({
      amountInMajorUnits: this.displayAmount.displayInMajor,
      // symbol:
      isApproximate: true,
      fractionDigits: exponent,
      withSign: true,
      currencyCode: this.displayAmount.currency,
    })
  }
}

// This function is copied and modified from flash-mobile: https://github.com/lnflash/flash-mobile/blob/6f500537ea8a286d07060b796d38a251b557e990/app/hooks/use-display-currency.ts#L57
const formatCurrencyHelper = ({
  amountInMajorUnits,
  symbol,
  isApproximate,
  fractionDigits,
  withSign = true,
  currencyCode,
}: {
  amountInMajorUnits: number | string
  isApproximate?: boolean
  symbol?: string
  fractionDigits: number
  currencyCode?: string
  withSign?: boolean
}) => {
  const isNegative = Number(amountInMajorUnits) < 0
  const decimalPlaces = fractionDigits
  const amountStr = Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
    // FIXME this workaround of using .format and not .formatNumber is
    // because hermes haven't fully implemented Intl.NumberFormat yet
  }).format(Math.abs(Math.floor(Number(amountInMajorUnits) * 100) / 100))
  return `${isApproximate ? "~" : ""}${
    isNegative && withSign ? "-" : ""
  }${symbol || ""}${amountStr}${currencyCode ? ` ${currencyCode}` : ""}`
}
