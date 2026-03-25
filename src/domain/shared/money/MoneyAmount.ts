import { Money, Round } from "../bigint-money"
import { WalletCurrency } from "../primitives"

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
  abstract i18n(): string

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
}



