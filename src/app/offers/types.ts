import { USDAmount, JMDAmount } from "@domain/shared"

// Full details in a cashout transaction
export type CashoutDetails = {
  readonly ibexTrx: {
    readonly userAcct: WalletId,
    readonly flashAcct: WalletId,
    readonly invoice: LnInvoice,
    readonly usd: USDAmount,
  },
  readonly flash: {
    readonly liability: {
      readonly usd: USDAmount,
      readonly jmd: JMDAmount,
    }
    readonly fee: USDAmount 
    readonly exchangeRate: JMDAmount,
  },
}

// Offer sent to the user
export type CashoutOffer = {
  offerId: OfferId,
  walletId: WalletId,
  send: USDAmount,
  receiveUsd: USDAmount,
  receiveJmd: JMDAmount,
  flashFee: USDAmount // BTC?
  expiresAt: Date
}

export type ValidationInputs = CashoutDetails & {
  wallet: Wallet,
  account: Account
}
export type ValidationFn = (inputs: ValidationInputs) => Promise<true | ValidationError>;

// Rtgs is Jamaican bank transfer
export type RtgsTransfer = {
  transactionId: string,
  senderAccountId: string, // sample
  receiverAccountId: string, // sample
  sent: JMDAmount | USDAmount
  fees?: number,
}
