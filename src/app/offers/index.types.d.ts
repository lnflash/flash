type OfferId = string & { readonly brand: unique symbol }


// type IbexCashout = CashoutDetails & {
//   readonly walletId: WalletId
// }

// type CashoutOffer = CashoutDetails & { id: OfferId };

type BasisPoints = bigint & { readonly brand: unique symbol }

type CashoutConfig = {
  fee: BasisPoints,
  duration: Seconds,
}

type ValidationConfig = {
  minimum: Amount<"USD">
  maximum: Amount<"USD">
  accountLevel: AccountLevel
}

