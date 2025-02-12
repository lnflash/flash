import { RepositoryError } from "@domain/errors"
import OffersRepository from "./db/OffersRepository"
// import { IOffersManager } from "."
import ValidOffer from "./ValidOffer"

const config: CashoutConfig = {
  feePercentage: .02, // 2 percent total fee
  duration: 360 as Seconds,
}

class OffersManager {
  // readonly Validator = new Validator(this.config)
  private constructor() {}

  static async makeCashoutOffer(
    walletId: WalletId, 
    flashSend: Amount<"USD">, 
  ): Promise<CashoutOffer | Error> {
    const flashFee = {
      amount: BigInt(Math.round(config.feePercentage * Number(flashSend.amount))),
      currency: "USD",
    } as Amount<"USD"> 

    const usdLiability = {
      amount: flashSend.amount - flashFee.amount,
      currency: "USD",
    } as Amount<"USD">
  
    const exchangeRate: number = 1.59 // USDcents to JMD 

    const jmdLiability = {
      amount: BigInt(Math.round(Number(usdLiability.amount) * exchangeRate)), 
      currency: "JMD",
    } as Amount<"JMD">
    
    const createdAt = new Date() // now
    const expiresAt = new Date(createdAt.getTime() + config.duration * 1000)

    const validated = await ValidOffer.from({
      walletId,
      ibexTransfer: flashSend,
      usdLiability,
      jmdLiability,
      flashFee,
      exchangeRate,
      createdAt,
      expiresAt,
    })
    if (validated instanceof Error) return validated

    const persistedOffer = await OffersRepository.upsert(validated)
    if (persistedOffer instanceof RepositoryError) return persistedOffer
  
    return {
      ...persistedOffer.details,
      id: persistedOffer.id
    }
  }

  static async executeOffer(id: OfferId): Promise<PaymentSendStatus | Error> {
    const offer = await OffersRepository.findById(id)
    if (offer instanceof RepositoryError) return offer
    
    const validOffer = await ValidOffer.from(offer.details)
    if (validOffer instanceof Error) return validOffer

    return validOffer.execute() 
  }
}

export default OffersManager