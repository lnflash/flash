import Offer from "./Offer"
import { RepositoryError } from "@domain/errors"
import PersistedOffer from "./db/PersistedOffer"
import Currency from "@graphql/public/types/object/currency"
import OffersRepository from "./db/OffersRepository"
import { LedgerService } from "@services/ledger"

type CashoutConfig = {
  feePercentage: number,
  duration: Seconds,
}

class OffersManager implements IOffersManager {
  readonly config: CashoutConfig = {
    feePercentage: .02, // 2 percent total fee
    duration: 360 as Seconds,
  }
  
  async makeCashoutOffer(
    walletId: WalletId, 
    flashSend: Amount<"USD">, 
  ): Promise<CashoutOfferResponse | Error> {
    const flashFee = {
      amount: BigInt(this.config.feePercentage * Number(flashSend.amount)),
      currency: "USD",
    } as Amount<"USD"> 

    const createdAt = new Date() // now
    const expiresAt = new Date(createdAt.getTime() + this.config.duration * 1000)

    const usdLiability = {
      amount: flashSend.amount - flashFee.amount,
      currency: "USD",
    } as Amount<"USD">
  
    const exchangeRate = 159 // await getPrice("JMD")

    const jmdLiability = {
      amount: usdLiability.amount * BigInt(exchangeRate), 
      currency: "JMD",
    } as Amount<"JMD">

    const offer = await (new Offer({
      walletId,
      ibexTransfer: flashSend,
      usdLiability,
      jmdLiability,
      flashFee,
      exchangeRate,
      createdAt,
      expiresAt,
    }).validate())
    if (offer instanceof Error) return offer

    const persistedOffer = await offer.persist()
    if (persistedOffer instanceof RepositoryError) return persistedOffer
    
    return toUser(persistedOffer)
  }

  async executeOffer(id: OfferId): Promise<PaymentSendStatus | Error> {
    const offer = await OffersRepository.findById(id)
    if (offer instanceof RepositoryError) return offer

    const validOffer = await offer.validate()
    if (validOffer instanceof Error) return validOffer

    return validOffer.execute() 
  }
}

const toUser = (o: PersistedOffer): CashoutOfferResponse => {
  return { 
    id: o.id,
    sendFlash: o.details.ibexTransfer,
    rtgsReceiveUSD: o.details.usdLiability,
    rtgsReceiveJMD: o.details.jmdLiability,
    flashFee: o.details.flashFee,
    exchangeRate: o.details.exchangeRate,
    expiresAt: o.details.expiresAt, 
  }
}

export default OffersManager