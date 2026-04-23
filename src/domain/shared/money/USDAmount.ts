import Money, { PRECISION_M, Round } from "../bigint-money"
import { MoneyAmount } from "./MoneyAmount"
import { WalletCurrency } from "../primitives"
import { BigIntConversionError } from "../errors"
import { getCurrencyMajorExponent } from "@domain/fiat/display-currency"

export class USDAmount extends MoneyAmount {
  static currencyId: IbexCurrencyId = 3 as IbexCurrencyId

  private constructor(amount: Money | bigint | string | number) {
    super(amount, WalletCurrency.Usd)
  }

  static cents(cents: string | bigint): USDAmount | BigIntConversionError {
    try {
      return new USDAmount(cents)
    } catch (error) {
      return new BigIntConversionError(error instanceof Error ? error.message : String(error))
    }
  }

  // convert dollars to cents
  static dollars(d: number | string): USDAmount | BigIntConversionError {
    try {
      const dollarAmt = new Money(d.toString(), "USDollars", Round.HALF_TO_EVEN)
      const cents = USDAmount.cents(100n)
      if (cents instanceof BigIntConversionError) return cents // should never happen
      return new USDAmount(cents.money.multiply(dollarAmt).toFixed(2))
    } catch (error) {
      return new BigIntConversionError(error instanceof Error ? error.message : String(error))
    }

  }

  static ZERO = new USDAmount(0)

  asCents(precision: number = 0): string {
    return this.money.toFixed(precision)
  }

  asDollars(precision: number = 2): string {
    return this.money.divide(100).toFixed(precision)
  }

  // const jmdLiability = {
  //   amount: BigInt(usdLiability.asCents()) * exchangeRate / 100n, 
  //   currency: "JMD",
  // }
  // Rate is the ratio at which one currency can be exchanged for another.
  // T:USD  
  convertAtRate<T extends MoneyAmount>(rate: T): T {
    const converted = rate.money.multiply(this.money).divide(100)
    return rate.getInstance(converted)
  }

  toIbex(): number {
    return Number(this.asDollars(8))
  }

  getInstance(amount: Money): this {
    return new USDAmount(amount) as this
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

  asPaymentAmount(): Amount<WalletCurrency> {
    return {
      currency: this.currencyCode,
      amount: this.money.toSource() / PRECISION_M,
    }
  }
}