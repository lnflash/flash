import { getI18nInstance } from "@config"

import { getCurrencyMajorExponent, MajorExponent } from "@domain/fiat"
import { WalletCurrency } from "@domain/shared"
import { getLanguageOrDefault } from "@domain/locale"

const i18n = getI18nInstance()

const customToLocaleString = (
  number: number,
  locale: Intl.LocalesArgument,
  options: Intl.NumberFormatOptions,
) => {
  const isWholeNumber = number % 1 === 0
  if (isWholeNumber) {
    options.maximumFractionDigits = 0
  } else {
    options.minimumFractionDigits = options.maximumFractionDigits
  }
  return number.toLocaleString(locale, options)
}

export const createPushNotificationContent = <T extends DisplayCurrency>({
  type,
  amount,
  displayAmount,
  userLanguage,
}: {
  type: NotificationType | "balance"
  amount: Amount<WalletCurrency>
  displayAmount?: DisplayAmount<T>
  userLanguage: UserLanguageOrEmpty
}): {
  title: string
  body: string
} => {
  const locale = getLanguageOrDefault(userLanguage)
  const baseCurrency = amount.currency
  const notificationType = type === "balance" ? type : `transaction.${type}`
  const title = i18n.__(
    { phrase: `notification.${notificationType}.title`, locale },
    { walletCurrency: baseCurrency },
  )
  const baseCurrencyName = baseCurrency === WalletCurrency.Btc ? "sats" : ""
  const displayedBaseAmount =
    baseCurrency === WalletCurrency.Usd ? Number(amount.amount) / 100 : amount.amount
  const baseCurrencyAmount = customToLocaleString(Number(displayedBaseAmount), locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: MajorExponent.STANDARD,
    currency: baseCurrency,
    style: baseCurrency === WalletCurrency.Btc ? "decimal" : "currency",
    currencyDisplay: "narrowSymbol",
  })

  let body = i18n.__(
    { phrase: `notification.${notificationType}.body`, locale },
    {
      baseCurrencyAmount,
      baseCurrencyName: baseCurrencyName ? ` ${baseCurrencyName}` : "",
    },
  )

  if (
    displayAmount &&
    displayAmount.amountInMinor > 0n &&
    displayAmount.currency !== baseCurrency
  ) {
    // const exponent = getCurrencyMajorExponent(displayAmount.currency)
    // const displayCurrencyAmount = customToLocaleString(
    //   Number(displayAmount.displayInMajor),
    //   locale,
    //   {
    //     minimumFractionDigits: 0,
    //     maximumFractionDigits: exponent,
    //     currency: displayAmount.currency,
    //     style: "currency",
    //     currencyDisplay: "narrowSymbol",
    //   },
    // )
    const displayCurrencyAmount: string = new CurrencyFormatter(displayAmount.currency).toString(displayAmount.displayInMajor)
    body = i18n.__(
      { phrase: `notification.${notificationType}.bodyDisplayCurrency`, locale },
      {
        displayCurrencyAmount,
        baseCurrencyAmount,
        baseCurrencyName: baseCurrencyName ? ` ${baseCurrencyName}` : "",
      },
    )
  }

  return { title, body }
}



class CurrencyFormatter {
  // exponent: CurrencyMajorExponent
  // amountInMajorUnits,
  // symbol: string
  // isApproximate,
  // fractionDigits,
  // withSign = true,
  // currencyCode,

  constructor(private currency: DisplayCurrency) {}

  // Ideally, currency list would be static and not require loading
  toString(amount: DisplayCurrencyMajorAmount): string {
    const exponent = getCurrencyMajorExponent(this.currency) 
    // const priceServerResp = await listCurrencies()
    // (priceServerResp typeof PriceCurrency) ? priceServerResp[this.currency] : "",
    return formatCurrencyHelper({
      amountInMajorUnits: amount,
      // symbol:
      isApproximate: true,
      fractionDigits: exponent,
      withSign: true,
      currencyCode: this.currency,
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