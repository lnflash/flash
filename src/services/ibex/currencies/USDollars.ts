import { AmountCalculator } from "@domain/shared"

// Ibex represents dollars as numbers with decimal to 2 places. e.g 1.25
export default class USDollars extends IbexCurrency {
  readonly amount: number
  static currencyId = 3 as IbexCurrencyId

  private constructor(amount: number) {
    super()
    this.amount = amount
  }

  static fromAmount(a: Amount<"USD">): USDollars {
    return new USDollars(Number(AmountCalculator().divRound(a, 100n)))
  }
  
  static fromFractionalCents(cents: FractionalCentAmount): USDollars {
    return new USDollars(cents / 100)
  }
}