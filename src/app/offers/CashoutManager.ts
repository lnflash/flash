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
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { RepositoryError } from "@domain/errors"
import ErpNext from "@services/frappe/ErpNext"
import { BankAccountQueryError } from "@services/frappe/errors"

const config = { 
  ...Cashout.OfferConfig,
  ...ExchangeRates,
}

const CashoutManager = {
  createOffer: async (
    walletId: WalletId, 
    userPayment: USDAmount, 
    bankAccountId: string,
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

    const serviceFee = userPayment.multiplyBips(config.fee)
    const usdPayout = userPayment.subtract(serviceFee)
    const exchangeRate = config.jmd.sell // todo: get from price server
    const jmdPayout = usdPayout.convertAtRate(exchangeRate)

    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof RepositoryError) return new ValidationError(wallet)
    const account = await AccountsRepository().findById(wallet.accountId)
    if (account instanceof RepositoryError) return new ValidationError(account)
    if (!account.erpParty) return new Error("Could not find erpParty for account")

    const bankAccounts = await ErpNext.getBankAccountsByCustomer(account.erpParty!)
    if (bankAccounts instanceof BankAccountQueryError) return bankAccounts
    const bankAccount = bankAccounts.find(b => b.name === bankAccountId)
    if (!bankAccount) return new ValidationError(`Bank account not found: ${bankAccountId}`)

    const isJmdPayout = bankAccount.currency === "JMD"
    const payout = isJmdPayout
      ? { bankAccountId, amount: jmdPayout, serviceFee, exchangeRate }
      : { bankAccountId, amount: usdPayout, serviceFee }

    const validated = await ValidOffer.from({
      payment: {
        userAcct: walletId,
        flashAcct: flashWallet,
        invoice,
        amount: userPayment,
      },
      payout,
    })
    if (validated instanceof ValidationError) return validated

    const persistedOffer = await Storage.add(validated)
    if (persistedOffer instanceof CacheServiceError) return persistedOffer
    return persistedOffer
  },

  executeCashout: async (id: OfferId, walletId: WalletId): Promise<InitiatedCashout | Error> => {
    const offer = await Storage.get(id)
    if (offer instanceof Error) return offer
  
    if (walletId !== offer.details.payment.userAcct) return new ValidationError("Offer is not good for provided wallet.")

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

export default CashoutManager