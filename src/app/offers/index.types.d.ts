// import PersistedOffer from "./db/PersistedOffer"




type OfferId = string & { readonly brand: unique symbol }

type CashoutDetails  = {
  readonly walletId: WalletId,
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
}

// application does not have access to the user's RTGS bank account details, 
// so our offer must provide USD and JMD transfer
// type CashoutOffer = CashoutDetails & {
//   readonly id: OfferId
// }

// interface CashoutOffer extends CashoutDetails {
//   readonly id: OfferId
// }
