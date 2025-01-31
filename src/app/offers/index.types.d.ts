interface IOffersManager {
  makeCashoutOffer(
    walletId: WalletId,
    sendFlash: Amount<"USD">, 
  ): Promise<CashoutOfferResponse | Error>

  executeOffer(id: OfferId): Promise<PaymentSendStatus | Error>
}

type OfferId = string & { readonly brand: unique symbol }

// application does not have access to the user's RTGS bank account details, 
// so our offer must provide USD and JMD transfer
type CashoutOfferResponse = {
  readonly id: OfferId
  readonly sendFlash: Amount<"USD">
  readonly rtgsReceiveUSD: Amount<"USD"> 
  readonly rtgsReceiveJMD: Amount<"JMD">
  readonly flashFee: Amount<"USD">
  readonly exchangeRate: number
  readonly expiresAt: Date
}

