import { USDAmount, USDTAmount, JMDAmount } from "@domain/shared"

// Full details in a cashout transaction
export type CashoutDetails = {
  readonly payment: {
    readonly userAcct: WalletId,
    readonly flashAcct: WalletId,
    readonly invoice: LnInvoice,
    // USD pre-cutover; USDT once the source account has migrated to the cash wallet.
    readonly amount: USDAmount | USDTAmount,
  },
  readonly payout: {
    readonly bankAccountId: string,
    readonly amount: USDAmount | JMDAmount,
    readonly serviceFee: USDAmount,
    readonly exchangeRate?: JMDAmount,
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

// Rtgs is Jamaican bank transfer
export type RtgsTransfer = {
  transactionId: string,
  senderAccountId: string, // sample
  receiverAccountId: string, // sample
  sent: JMDAmount | USDAmount
  fees?: number,
}
