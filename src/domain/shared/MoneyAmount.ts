import { Money, Round } from "./bigint-money"
import { BigIntConversionError, RedisParseError } from "./errors"
import { ExchangeCurrencyUnit, WalletCurrency } from "./primitives"

export abstract class MoneyAmount {
  readonly money: Money
  readonly currencyCode: WalletCurrency

  constructor(amount: Money | bigint | string | number, currencyCode: WalletCurrency) {
    this.currencyCode = currencyCode
    if (amount instanceof Money) {
      this.money = amount
      return
    }
    this.money = new Money(amount, currencyCode, Round.HALF_TO_EVEN)
  }

  abstract getInstance(amount: Money): this

  multiplyBips(bips: BasisPoints): this {
    return this.getInstance(this.money.multiply(bips.toString()).divide(10000))
  }

  subtract(b: this): this {
    return this.getInstance(this.money.subtract(b.money))
  }

  isLesserThan(b: this): boolean {
    return this.money.isLesserThan(b.money)
  }

  isGreaterThan(b: this): boolean {
    return this.money.isGreaterThan(b.money)
  }

  isZero(): boolean {
    return this.money.isEqual(0)
  }

  toJson(): [string, string] {
    return this.money.toJSON()
  }

  fromSource(val: string, currency: WalletCurrency): this {
    return this.getInstance(new Money(val, currency, Round.HALF_TO_EVEN))
  }

  static fromJSON(val: [string, string]): MoneyAmount | BigIntConversionError {
    const [amt, currency] = val

    if (currency === WalletCurrency.Usd) return USDAmount.cents(amt)
    else if (currency === WalletCurrency.Jmd) return JMDAmount.cents(amt)
    else return new RedisParseError(`Could not read currency: ${currency}`)
  }
}

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
      const dollarAmt = new Money(d, "USDollars", Round.HALF_TO_EVEN)
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

  /**
   * Create graphql Payload as done in normalizePaymentAmount 
   * @returns 
   */
  gqlPayload(): PaymentAmountPayload<ExchangeCurrencyUnit> {
    return {
      amount: Number(this.asCents(0)),
      currencyUnit: ExchangeCurrencyUnit.Usd, 
    }
  }
  
  toIbex(): number {
    return Number(this.asDollars(8))
  }

  getInstance(amount: Money): this {
    return new USDAmount(amount) as this
  }
}

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
}

