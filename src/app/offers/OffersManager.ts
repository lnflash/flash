import Storage from "./storage/Redis"
import ValidOffer from "./ValidOffer"
import { ValidationError } from "@domain/shared"
import { CacheServiceError } from "@domain/cache"

const config: CashoutConfig = {
  feePercentage: .02, // 2 percent total fee
  duration: 600 as Seconds, // 10 minutes
}

// See Foreign Exchange Rates: https://www.firstglobal-bank.com/
const JMD_SELL_RATE = 159
const JMD_BUY_RATE = 151

const OffersManager = {
  createCashoutOffer: async (
    walletId: WalletId, 
    flashSend: Amount<"USD">, 
  ): Promise<CashoutOffer | Error> => {
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
    if (validated instanceof ValidationError) return validated

    const persistedOffer = await Storage.add(validated)
    if (persistedOffer instanceof CacheServiceError) return persistedOffer
  
    return {
      ...persistedOffer.details,
      id: persistedOffer.id
    }
  },

  executeOffer: async (id: OfferId, walletId: WalletId): Promise<PaymentSendStatus | Error> => {
    const offer = await Storage.get(id)
    if (offer instanceof CacheServiceError) return offer
  
    if (walletId !== offer.details.walletId) return new ValidationError("Offer is not good for provided wallet.")

    const validOffer = await ValidOffer.from(offer.details)
    if (validOffer instanceof Error) return validOffer

    return validOffer.execute() 
  },

}

export default OffersManager