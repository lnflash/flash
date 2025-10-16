import Storage from "./storage/Redis"
import ValidOffer, { InitiatedCashout } from "./ValidOffer"
import { USDAmount, ValidationError } from "@domain/shared"
import { CacheServiceError } from "@domain/cache"
import { getBankOwnerIbexAccount } from "@services/ledger/caching"
import Ibex from "@services/ibex/client"
import { UnexpectedIbexResponse } from "@services/ibex/errors"
import { decodeInvoice, PaymentSendStatus } from "@domain/bitcoin/lightning"
import { Cashout, ExchangeRates } from "@config"
import PersistedOffer from "./storage/PersistedOffer"
import { EmailService } from "@services/email"

const config = { 
  ...Cashout.OfferConfig,
  ...ExchangeRates,
}

const OffersManager = {
  createCashoutOffer: async (
    walletId: WalletId, 
    userPayment: USDAmount, 
  ): Promise<PersistedOffer | Error> => {
    const flashWallet = await getBankOwnerIbexAccount()

    const invoiceResp = await Ibex.addInvoice({ 
      accountId: flashWallet,
      memo: "User withdraw to bank",
      amount: userPayment, 
      expiration: config.duration,
    })
    if (invoiceResp instanceof Error) return invoiceResp
    if (invoiceResp.invoice?.bolt11 === undefined) return new UnexpectedIbexResponse("Bolt11 field not found.")
    const invoice = decodeInvoice(invoiceResp.invoice.bolt11)
    if (invoice instanceof Error) return invoice

    const flashFee = userPayment.multiplyBips(config.fee)
    const usdLiability = userPayment.subtract(flashFee)
    const exchangeRate = config.jmd.sell // todo: get from price server
    const jmdLiability = usdLiability.convertAtRate(exchangeRate) 

    const validated = await ValidOffer.from({
      ibexTrx: {
        userAcct: walletId,
        flashAcct: flashWallet,
        invoice,
        usd: userPayment,
        // currency: "USD",
      },
      flash: {
        liability: {
          usd: usdLiability,
          jmd: jmdLiability,
        },
        exchangeRate,
        fee: flashFee,
      },
    })
    if (validated instanceof ValidationError) return validated

    const persistedOffer = await Storage.add(validated)
    if (persistedOffer instanceof CacheServiceError) return persistedOffer
    return persistedOffer
  },

  executeCashout: async (id: OfferId, walletId: WalletId): Promise<InitiatedCashout | Error> => {
    const offer = await Storage.get(id)
    if (offer instanceof Error) return offer
  
    if (walletId !== offer.details.ibexTrx.userAcct) return new ValidationError("Offer is not good for provided wallet.")

    const validOffer = await ValidOffer.from(offer.details)
    if (validOffer instanceof Error) return validOffer

    const executedOffer = await validOffer.execute() 
    if (executedOffer instanceof Error) return executedOffer
    else {
      EmailService.sendCashoutInitiatedEmail(executedOffer)
      return executedOffer
    }
  },

}

export default OffersManager