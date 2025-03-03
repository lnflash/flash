type IbexCurrencyId = number & { readonly brand: unique symbol }

interface IbexCurrency {
  readonly amount: number
  currencyId: IbexCurrencyId
}

type IbexAccountId = WalletId

type IbexInvoiceArgs = { 
  accountId: IbexAccountId,
  amount?: IbexCurrency;  
  memo: string
  expiration?: Seconds 
};
type AccountArgs = { name: string, currency: WalletCurrency }
type IbexTransactionId = string & { readonly brand: unique symbol }
type GetFeeEstimateArgs = {
  invoice: Bolt11,
  send: {
    amount?: number, 
    currencyId: IbexCurrencyId,
  }
}

type PayInvoiceArgs = {
  accountId: IbexAccountId,
  invoice: Bolt11,
  send?: IbexCurrency // must match currency of account
}

type PayLnurlArgs = {
  accountId: IbexAccountId,
  send: IbexCurrency,
  params: string, // what is this?
}

// Flash types
type FeeEstimation = GetFeeEstimateArgs & {
  fee: IbexCurrency,
}
type Bolt11 = string & { readonly brand: unique symbol }
