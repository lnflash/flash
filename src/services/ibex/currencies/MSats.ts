import { paymentAmountFromNumber, WalletCurrency } from "@domain/shared"
import { IbexCurrency } from "./IbexCurrency"

// Bitcoin accounts in Ibex are denominated in Msats
export default class MSats extends IbexCurrency {
  static currencyId = 0 as IbexCurrencyId
  readonly currencyId: IbexCurrencyId = this.currencyId 

  private constructor(amount: number) {
    super(amount)
  }

  static fromIbex(a: number): MSats {
    return new MSats(a)
  }

  static fromAmount(a: Amount<"BTC">): MSats {
    return new MSats(Number(a.amount))
  }

  toSats(): Amount<"BTC"> | ValidationError {
    return paymentAmountFromNumber({
      amount: Math.round(this.amount / 1000), 
      currency: WalletCurrency.Btc
    })
  } 
}