type IbexCurrencyId = number & { readonly brand: unique symbol }

declare abstract class IbexCurrency {
  readonly amount: number
  currencyId: IbexCurrencyId
}

type IbexAccountId = WalletId

type IbexInvoiceArgs = { // Omit<import("ibex-client/dist/.api/apis/sing-in/types").AddInvoiceBodyParam, 'amount'> & {
  accountId: IbexAccountId,
  amount?: IbexCurrency;  
  memo: string
  expiration?: Seconds 
};
type AddInvoiceResponse = import("ibex-client/dist/.api/apis/sing-in/types").AddInvoiceResponse201 
type GetIbexTransactionsArgs = import("ibex-client/dist/.api/apis/sing-in/types").GMetadataParam
type TransactionResponse = import("ibex-client/dist/.api/apis/sing-in/types").GResponse200
type AccountArgs = { name: string, currency: WalletCurrency }
type IbexTransactionId = string & { readonly brand: unique symbol }
type GetFeeEstimateArgs = {
  invoice: Bolt11,
  send: {
    amount?: number, 
    currencyId: IbexCurrencyId,
  }
}
// type GetFeeEstimateResponse = { amount?: number, invoiceAmount?: number }

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
