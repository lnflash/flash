type OfferId = string & { readonly brand: unique symbol }

type CashoutDetails  = {
  readonly walletId: WalletId
  readonly ibexTransfer: Amount<"USD">
  readonly usdLiability: Amount<"USD">
  readonly jmdLiability: Amount<"JMD">
  readonly exchangeRate: number 
  readonly flashFee: Amount<"USD">
  readonly createdAt: Date
  readonly expiresAt: Date
}

type CashoutOffer = CashoutDetails & { id: OfferId };

type CashoutConfig = {
  feePercentage: number,
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
