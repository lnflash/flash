import { resolveCashoutWalletSelection } from "@app/cash-wallet-cutover/cashout-routing"
import { Cashout } from "@config"
import { decodeInvoice } from "@domain/bitcoin/lightning"
import { CacheServiceError } from "@domain/cache"
import { USDAmount, USDTAmount, ValidationError } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { UnexpectedIbexResponse } from "@services/ibex/errors"
import { getBankOwnerIbexAccount } from "@services/ledger/caching"

import { RepositoryError } from "@domain/errors"
import { EmailService } from "@services/email"
import ErpNext from "@services/frappe/ErpNext"
import { BankAccountQueryError, ExchangeRateQueryError } from "@services/frappe/errors"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"

import PersistedOffer from "./storage/PersistedOffer"
import Storage from "./storage/Redis"
import { CashoutDetails } from "./types"
import ValidOffer, { InitiatedCashout } from "./ValidOffer"

const config = {
  ...Cashout.OfferConfig,
}

const CashoutManager = {
  createOffer: async (
    walletId: WalletId,
    userPayment: USDAmount,
    bankAccountId: string,
  ): Promise<PersistedOffer | Error> => {
    const bankOwnerUsdWalletId = await getBankOwnerIbexAccount()

    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof RepositoryError) return new ValidationError(wallet)
    const account = await AccountsRepository().findById(wallet.accountId)
    if (account instanceof RepositoryError) return new ValidationError(account)
    if (!account.erpParty) return new Error("Could not find erpParty for account")

    // Source (user) and destination (Flash bank-owner) wallets are resolved from the
    // cutover guard — not from the client-supplied walletId, which is trusted only for
    // wallet-level auth. Post-cutover this routes the debit to the account's USDT wallet
    // and the bank-owner's USDT wallet; pre-cutover it stays on the legacy USD wallets.
    const selection = await resolveCashoutWalletSelection({
      accountId: account.id,
      requestedUserWalletId: walletId,
      bankOwnerUsdWalletId,
    })
    if (selection instanceof Error) return selection

    // 1 USDT = 1 USD; the JMD/USD payout math below stays USD-denominated regardless.
    const paymentAmount =
      selection.route === "usdt"
        ? USDTAmount.usdCents(userPayment.asCents())
        : userPayment
    if (paymentAmount instanceof Error) return paymentAmount

    const invoiceResp = await Ibex.addInvoice({
      accountId: selection.flashWalletId,
      memo: "User withdraw to bank",
      amount: paymentAmount,
      expiration: config.duration,
    })
    if (invoiceResp instanceof Error) return invoiceResp
    if (invoiceResp.invoice?.bolt11 === undefined)
      return new UnexpectedIbexResponse("Bolt11 field not found.")
    const invoice = decodeInvoice(invoiceResp.invoice.bolt11)
    if (invoice instanceof Error) return invoice

    const serviceFee = userPayment.multiplyBips(config.fee)
    const usdPayout = userPayment.subtract(serviceFee)

    const bankAccounts = await ErpNext.getBankAccountsByCustomer(account.erpParty!)
    if (bankAccounts instanceof BankAccountQueryError) return bankAccounts
    const bankAccount = bankAccounts.find((b) => b.name === bankAccountId)
    if (!bankAccount)
      return new ValidationError(`Bank account not found: ${bankAccountId}`)

    const isJmdPayout = bankAccount.currency === "JMD"

    // JMD cashout settles at NCB's buy rate, scraped weekly into ERPNext. Fail
    // closed: never build a JMD offer at a guessed rate if the live rate is missing.
    let payout: CashoutDetails["payout"]
    if (isJmdPayout) {
      const exchangeRate = await ErpNext.getCashoutExchangeRate()
      if (exchangeRate instanceof ExchangeRateQueryError) return exchangeRate
      payout = {
        bankAccountId,
        amount: usdPayout.convertAtRate(exchangeRate),
        serviceFee,
        exchangeRate,
      }
    } else {
      payout = { bankAccountId, amount: usdPayout, serviceFee }
    }

    const validated = await ValidOffer.from({
      payment: {
        userAcct: selection.userWalletId,
        flashAcct: selection.flashWalletId,
        invoice,
        amount: paymentAmount,
      },
      payout,
    })
    if (validated instanceof ValidationError) return validated

    const persistedOffer = await Storage.add(validated)
    if (persistedOffer instanceof CacheServiceError) return persistedOffer
    return persistedOffer
  },

  executeCashout: async (
    id: OfferId,
    walletId: WalletId,
  ): Promise<InitiatedCashout | Error> => {
    const offer = await Storage.get(id)
    if (offer instanceof Error) return offer

    // walletId authenticates the caller at the wallet level; the offer's settlement wallet
    // may differ from it (e.g. a USDT cash wallet post-cutover while an older client still
    // presents the legacy USD walletId). Authorize when both belong to the same account.
    const providedWallet = await WalletsRepository().findById(walletId)
    if (providedWallet instanceof RepositoryError)
      return new ValidationError(providedWallet)
    const settlementWallet = await WalletsRepository().findById(
      offer.details.payment.userAcct,
    )
    if (settlementWallet instanceof RepositoryError)
      return new ValidationError(settlementWallet)
    if (providedWallet.accountId !== settlementWallet.accountId)
      return new ValidationError("Offer is not good for provided wallet.")

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
