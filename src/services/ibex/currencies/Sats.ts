import { IbexCurrency } from "./IbexCurrency"

// Ibex represents dollars as numbers with decimal to 2 places. e.g 1.25
export default class Sats extends IbexCurrency {
  readonly currencyId = 1 as IbexCurrencyId
  static currencyId: IbexCurrencyId = this.currencyId 

  private constructor(amount: number) {
    super(amount)
  }

  static fromAmount(a: Amount<"BTC">): Sats {
    return new Sats(Number(a.amount))
  }
}