import { getCurrencyMajorExponent } from "@domain/fiat/display-currency"

import Money, { Round } from "../bigint-money"

import { BigIntConversionError } from "../errors"
import { WalletCurrency } from "../primitives"

import { MoneyAmount } from "./MoneyAmount"

export class JMDAmount extends MoneyAmount {
  currencyCode = WalletCurrency.Jmd as WalletCurrency

  private constructor(amount: Money | bigint | string | number) {
    super(amount, WalletCurrency.Jmd)
  }

  static cents(c: string): JMDAmount | BigIntConversionError {
    try {
      return new JMDAmount(c)
    } catch (error) {
      return new BigIntConversionError(
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  static dollars(d: number): JMDAmount | BigIntConversionError {
    try {
      // Mirror USDAmount.dollars: use the Money lib for a decimal-safe conversion.
      // BigInt(d) throws on any fractional rate (e.g. an NCB rate of 155.5), which
      // is what the exchange-rate value virtually always is.
      const dollarAmt = new Money(d.toString(), "JMDollars", Round.HALF_TO_EVEN)
      const cents = JMDAmount.cents("100")
      if (cents instanceof BigIntConversionError) return cents // should never happen
      return new JMDAmount(cents.money.multiply(dollarAmt).toFixed(2))
    } catch (error) {
      return new BigIntConversionError(
        error instanceof Error ? error.message : String(error),
      )
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
    const exponent = getCurrencyMajorExponent(this.currencyCode as DisplayCurrency)
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: this.currencyCode,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(Number(this.asDollars()))
  }
}
