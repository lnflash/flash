type OfferId = string & { readonly brand: unique symbol }

type Bolt11 = string // Verify format

type Liability<T extends WalletCurrency> = Amount<T> & {
  exchangeRate: Amount<"USD"> // Exchange rate of USD->T
}

type CashoutDetails = {
  readonly invoice: Bolt11,
  readonly rtgs: {
    readonly liability: {
      usd: Liability<"USD">,
      jmd: Liability<"JMD">,
    }
  },
  readonly flashFee: Amount<"USD"> // BTC?
}

type IbexCashout = CashoutDetails & {
  readonly walletId: WalletId
}

type CashoutOffer = CashoutDetails & { id: OfferId };

type BasisPoints = BigInt

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
