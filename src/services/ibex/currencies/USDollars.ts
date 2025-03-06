import { AmountCalculator, paymentAmountFromNumber, toNumber, WalletCurrency } from "@domain/shared"
import { IbexCurrency } from "./IbexCurrency"

// Ibex represents dollars as numbers with decimal to 2 places. e.g 1.25
export default class USDollars extends IbexCurrency {
  static currencyId = 3 as IbexCurrencyId 
  readonly currencyId = 3 as IbexCurrencyId

  private constructor(amount: number) {
    super(amount)
  }

  static fromIbex(a: number): USDollars {
    return new USDollars(a)
  }

  static fromAmount(a: Amount<"USD">): USDollars {
    return new USDollars(toNumber(a) / 100)
  }
  
  static fromFractionalCents(cents: FractionalCentAmount): USDollars {
    return new USDollars(cents / 100)
  }

  toCents(): Amount<"USD"> | ValidationError{
    return paymentAmountFromNumber({
      amount: Math.ceil(this.amount * 100), 
      currency: WalletCurrency.Usd
    })
  } 
}