
export abstract class IbexCurrency {
  readonly amount: number
  abstract currencyId: IbexCurrencyId
  constructor(amount: number) {
    this.amount = amount
  }
}