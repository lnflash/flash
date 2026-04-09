import Money, { Round } from "../bigint-money"
import { MoneyAmount } from "./MoneyAmount"
import { WalletCurrency } from "../primitives"
import { BigIntConversionError } from "../errors"
import { getCurrencyMajorExponent } from "@domain/fiat/display-currency"


export class JMDAmount extends MoneyAmount {
  currencyCode = WalletCurrency.Jmd as WalletCurrency

  private constructor(amount: Money | bigint | string | number) {
    super(amount, WalletCurrency.Jmd)
  }

  static cents(c: string): JMDAmount | BigIntConversionError {
    try {
      return new JMDAmount(c)
    } catch (error) {
      return new BigIntConversionError(error instanceof Error ? error.message : String(error))
    }
  }

  static dollars(d: number): JMDAmount | BigIntConversionError {
    try {
      return new JMDAmount(BigInt(d) * 100n)
    } catch (error) {
      return new BigIntConversionError(error instanceof Error ? error.message : String(error))
    }

  }

  asCents(precision: number = 0): string {
    return this.money.toFixed(precision)
  }

  asDollars(precision: number = 2): string {
    return this.money.divide(100).toFixed(precision)
  }

  getInstance(amount: Money): this {
    return new JMDAmount(amount) as this
  }

  i18n(): string {
    const exponent = getCurrencyMajorExponent(this.currencyCode as DisplayCurrency);
    return new Intl.NumberFormat("en", {
        style: "currency",
        currency: this.currencyCode,
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: exponent,
        maximumFractionDigits: exponent,
    }).format(Number(this.asDollars()));
  }
}