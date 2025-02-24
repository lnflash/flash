// Ibex represents dollars as numbers with decimal to 2 places. e.g 1.25
export default class Sats extends IbexCurrency {
  readonly amount: number
  static currencyId = 1 as IbexCurrencyId

  private constructor(amount: number) {
    super()
    this.amount = amount
  }

  static fromAmount(a: Amount<"BTC">): Sats {
    return new Sats(Number(a.amount))
  }
}