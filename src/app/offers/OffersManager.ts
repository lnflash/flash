import Storage from "./storage/Redis"
import ValidOffer from "./ValidOffer"
import { AmountCalculator, ValidationError } from "@domain/shared"
import { CacheServiceError } from "@domain/cache"
import { getBankOwnerIbexAccount } from "@services/ledger/caching"
import { UnexpectedIbexResponse } from "@services/ibex/client/errors"
import Ibex from "@services/ibex/client"
import webhookServer from "@services/ibex/webhook-server"

const config: CashoutConfig = {
  fee: 200n as BasisPoints, // 2 percent total fee
  duration: 600 as Seconds, // 10 minutes
}

// See Foreign Exchange Rates: https://www.firstglobal-bank.com/
const JMD_SELL_RATE = 159
const JMD_BUY_RATE = 151

const OffersManager = {
  createCashoutOffer: async (
    walletId: WalletId, 
    requested: Amount<"USD">, 
  ): Promise<CashoutOffer | Error> => {
    const flashWallet = await getBankOwnerIbexAccount()
    if (flashWallet instanceof Error) return flashWallet

    const invoiceResp = await Ibex().addInvoice({ 
      accountId: flashWallet.id,
      memo: "User withdraw to bank",
      amount: Number(requested.amount) / 100, // convert cents to dollars for Ibex api
      expiration: config.duration,
      webhookUrl: webhookServer.endpoints.onReceive.cashout,
      webhookSecret: webhookServer.secret,
    })
    if (invoiceResp instanceof Error) return invoiceResp
    if (invoiceResp.invoice?.bolt11 === undefined) return new UnexpectedIbexResponse("Bolt11 field not found.")

    const flashFee = AmountCalculator().mulBasisPoints(requested, config.fee as bigint)
    // const flashFee = {
    //   amount: BigInt(Math.round(config.feePercentage * Number(requested.amount))),
    //   currency: "USD",
    // } as Amount<"USD"> 

    const usdLiability = {
      amount: requested.amount - flashFee.amount,
      currency: "USD",
      exchangeRate: {
        amount: 1n,
        currency: "USD",
      }
    } as Liability<"USD">
  
    const exchangeRate: bigint = 159n // USDcents to JMD 

    const jmdLiability = {
      amount: BigInt(usdLiability.amount * exchangeRate / 100n), 
      currency: "JMD",
      exchangeRate: {
        amount: 159n,
        currency: "USD"
      }
    } as Liability<"JMD">
    
    const createdAt = new Date() // now
    // const expiresAt = new Date(createdAt.getTime() + config.duration * 1000)

    
    const validated = await ValidOffer.from({
      walletId,
      invoice: invoiceResp.invoice.bolt11,
      rtgs: {
        usdLiability,
        jmdLiability,
      },
      flashFee,
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