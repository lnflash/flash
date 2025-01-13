// import IbexAccount from "@services/ibex/IbexAccount"

type OfferId = string & { readonly brand: unique symbol }

// type Bolt11 = string // Verify format

type ExchangeAmount<T extends WalletCurrency> = Amount<T> & {
  exchangeRate: Amount<"USD"> // Exchange rate of USD->T
}

// Full details in a cashout transaction
type CashoutDetails = {
  readonly ibexTrx: {
    readonly userAcct: WalletId,
    readonly flashAcct: WalletId,
    readonly invoice: LnInvoice,
    readonly usdAmount: PaymentAmount<"USD">,
    readonly currency: WalletCurrency,
  }
  readonly liability: {
    readonly usd: PaymentAmount<"USD">,
    readonly jmd: ExchangeAmount<"JMD">,
  }
  readonly flashFee: Amount<"USD"> // BTC?
}

// Offer sent to the user
type CashoutOffer = {
  offerId: OfferId,
  walletId: WalletId,
  send: PaymentAmount<"USD">,
  receiveUsd: PaymentAmount<"USD">,
  receiveJmd: ExchangeAmount<"JMD">,
  flashFee: Amount<"USD"> // BTC?
  expiresAt: Date
}

// type IbexCashout = CashoutDetails & {
//   readonly walletId: WalletId
// }

// type CashoutOffer = CashoutDetails & { id: OfferId };

type BasisPoints = bigint

type CashoutConfig = {
  fee: BasisPoints,
  duration: Seconds,
}

type ValidationConfig = {
  minimum: Amount<"USD">
  maximum: Amount<"USD">
  accountLevel: AccountLevel
}

type ValidationInputs = CashoutDetails & {
  wallet: Wallet,
  account: Account
}
type ValidationFn = (inputs: ValidationInputs) => Promise<true | ValidationError>;
