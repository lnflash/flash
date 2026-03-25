import Money, { Round } from "../bigint-money"
import { MoneyAmount } from "./MoneyAmount"
import { WalletCurrency } from "../primitives"
import { BigIntConversionError } from "../errors"

export class BtcAmount extends MoneyAmount {
  currencyCode = WalletCurrency.Btc as WalletCurrency

  private constructor(amount: Money | bigint | string | number) {
    super(amount, WalletCurrency.Btc)
  }

  static sats(c: string): BtcAmount | BigIntConversionError {
    try {
      return new BtcAmount(c)
    } catch (error) {
      return new BigIntConversionError(error instanceof Error ? error.message : String(error))
    }
  }

  asSats(precision: number = 0): string {
    return this.money.toFixed(precision)
  }

  getInstance(amount: Money): this {
    return new BtcAmount(amount) as this
  }

  i18n(): string {
    return new Intl.NumberFormat("en", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(Number(this.asSats())) + " sats";
  }
}