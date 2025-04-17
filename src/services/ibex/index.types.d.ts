type IbexCurrencyId = number & { readonly brand: unique symbol }

interface IbexCurrency {
  readonly amount: number
  readonly currencyId: IbexCurrencyId
}

interface IbexAccount {
  readonly currencyId: IbexCurrencyId
  asIbexAmount(): number
  // static fromIbexAmount(amount: string): this
}

type IbexAccountId = WalletId

// type IbexInvoiceArgs = { 
//   accountId: IbexAccountId,
//   amount?: IbexAmount
//   memo: string
//   expiration?: Seconds 
// };
type AccountArgs = { name: string, currency: WalletCurrency }
type IbexTransactionId = string & { readonly brand: unique symbol }


type PayLnurlArgs = {
  accountId: IbexAccountId,
  send: IbexCurrency,
  params: string, // what is this?
}

// Flash types
// type FeeEstimation<T extends IbexCurrency>= GetFeeEstimateArgs<T> & {
//   fee: T,
// }
type Bolt11 = string & { readonly brand: unique symbol }

