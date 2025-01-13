import Storage from "./storage/Redis"
import ValidOffer from "./ValidOffer"
import { AmountCalculator, ValidationError } from "@domain/shared"
import { CacheServiceError } from "@domain/cache"
import { getBankOwnerIbexAccount } from "@services/ledger/caching"
import Ibex from "@services/ibex/client"
import webhookServer from "@services/ibex/webhook-server"
import { USDollars } from "@services/ibex/currencies"
import { UnexpectedIbexResponse } from "@services/ibex/errors"
import { decodeInvoice } from "@domain/bitcoin/lightning"

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
    requested: PaymentAmount<"USD">, 
  ): Promise<CashoutOffer | Error> => {
    const flashWallet = await getBankOwnerIbexAccount()
    // if (flashWallet instanceof Error) return flashWallet

    const invoiceResp = await Ibex.addInvoice({ 
      accountId: flashWallet,
      memo: "User withdraw to bank",
      amount: USDollars.fromAmount(requested), 
      expiration: config.duration,
    })
    if (invoiceResp instanceof Error) return invoiceResp
    if (invoiceResp.invoice?.bolt11 === undefined) return new UnexpectedIbexResponse("Bolt11 field not found.")
    const invoice = decodeInvoice(invoiceResp.invoice.bolt11)
    if (invoice instanceof Error) return invoice

    const flashFee = AmountCalculator().mulBasisPoints(requested, config.fee)

    const usdLiability = AmountCalculator().sub(requested, flashFee)
    const exchangeRate: bigint = 159n // USDcents to JMD 
    const jmdLiability = {
      amount: BigInt(usdLiability.amount * exchangeRate / 100n), 
      currency: "JMD",
      exchangeRate: {
        amount: 159n,
        currency: "USD"
      }
    } as ExchangeAmount<"JMD">
    
    const validated = await ValidOffer.from({
      ibexTrx: {
        userAcct: walletId,
        flashAcct: flashWallet,
        invoice,
        usdAmount: requested,
        currency: "USD",
      },
      liability: {
        usd: usdLiability,
        jmd: jmdLiability,
      },
      flashFee,
    })
    if (validated instanceof ValidationError) return validated

    const persistedOffer = await Storage.add(validated)
    if (persistedOffer instanceof CacheServiceError) return persistedOffer
  
    return {
      offerId: persistedOffer.id,
      walletId: persistedOffer.details.ibexTrx.userAcct,
      send: persistedOffer.details.ibexTrx.usdAmount,
      receiveUsd: persistedOffer.details.liability.usd,
      receiveJmd: persistedOffer.details.liability.jmd,
      flashFee: persistedOffer.details.flashFee,
      expiresAt: persistedOffer.details.ibexTrx.invoice.expiresAt,
    }
  },

  executeOffer: async (id: OfferId, walletId: WalletId): Promise<PaymentSendStatus | Error> => {
    const offer = await Storage.get(id)
    if (offer instanceof Error) return offer
  
    if (walletId !== offer.details.ibexTrx.userAcct) return new ValidationError("Offer is not good for provided wallet.")

    const validOffer = await ValidOffer.from(offer.details)
    if (validOffer instanceof Error) return validOffer

    return validOffer.execute() 
  },

}

export default OffersManager