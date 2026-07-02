import { getI18nInstance } from "@config"

import { CurrencyFormatter, MajorExponent } from "@domain/fiat"
import { WalletCurrency } from "@domain/shared"
import { getLanguageOrDefault } from "@domain/locale"

const i18n = getI18nInstance()
const USDT_MICROS_PER_MAJOR_UNIT = 1_000_000

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
  const walletCurrencyLabel = baseCurrency === WalletCurrency.Usdt ? "USD" : baseCurrency
  const notificationType = type === "balance" ? type : `transaction.${type}`
  const title = i18n.__(
    { phrase: `notification.${notificationType}.title`, locale },
    { walletCurrency: walletCurrencyLabel },
  )
  let baseCurrencyName = ""
  let displayedBaseAmount: number | bigint = amount.amount
  let numberFormatOptions: Intl.NumberFormatOptions = { style: "decimal" }

  if (baseCurrency === WalletCurrency.Btc) {
    baseCurrencyName = "sats"
  }

  if (baseCurrency === WalletCurrency.Usd) {
    displayedBaseAmount = Number(amount.amount) / 100
    numberFormatOptions = {
      currency: baseCurrency,
      style: "currency",
      currencyDisplay: "narrowSymbol",
    }
  }

  if (baseCurrency === WalletCurrency.Usdt) {
    baseCurrencyName = "USD"
    displayedBaseAmount = Number(amount.amount) / USDT_MICROS_PER_MAJOR_UNIT
  }

  const baseCurrencyAmount = customToLocaleString(Number(displayedBaseAmount), locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: MajorExponent.STANDARD,
    ...numberFormatOptions,
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
    body = i18n.__(
      { phrase: `notification.${notificationType}.bodyDisplayCurrency`, locale },
      {
        displayCurrencyAmount: new CurrencyFormatter(displayAmount).toString(),
        baseCurrencyAmount,
        baseCurrencyName: baseCurrencyName ? ` ${baseCurrencyName}` : "",
      },
    )
  }

  return { title, body }
}
