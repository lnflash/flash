import { WalletCurrency } from "../primitives"
import { UnsupportedCurrencyError } from "../errors"
import { MoneyAmount } from "./MoneyAmount"
import { USDAmount } from "./USDAmount"
import { JMDAmount } from "./JMDAmount"

export function toMoneyAmount(
  amount: number | string,
  currency: WalletCurrency,
): MoneyAmount | Error {
  if (currency === WalletCurrency.Usd) return USDAmount.cents(amount.toString())
  if (currency === WalletCurrency.Jmd) return JMDAmount.cents(amount.toString())
  return new UnsupportedCurrencyError(`Could not read currency: ${currency}`)
}

export function toMoneyAmountFromJSON(val: [string, string]): MoneyAmount | Error {
  return toMoneyAmount(val[0], val[1] as WalletCurrency)
}
