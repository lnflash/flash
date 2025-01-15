import {
  WalletCurrency,
  ZERO_CENTS,
  ZERO_SATS,
} from "@domain/shared"

import { MainBook } from "./books"

import { persistAndReturnEntry } from "./helpers"

import { LedgerError, LedgerServiceError, LedgerTransactionType } from "@domain/ledger"
import { staticAccountIds } from "./facade/static-account-ids"
import { getTransactionById } from "@app/wallets"
import { LedgerService } from "."

// See Foreign Exchange Rates: https://www.firstglobal-bank.com/
const JMD_SELL_RATE = 159
const JMD_BUY_RATE = 151

const toUSD = (liability: Amount<"JMD"> | Amount<"USD">): number => {
  const liabilityAmt = Number(liability.amount)
  if (liabilityAmt === 0) return 0 
  if (liability.currency === WalletCurrency.Usd) return Number(liability.amount)
  else return Number(liability.amount) / JMD_SELL_RATE
}

export const recordCashOut = async ({
  userWalletD,
  paymentDetails,
  liability,
}: RecordCashOutArgs): Promise<LedgerJournal | LedgerServiceError> => {
  // TODO: move to calling function: const ibexFee = paymentDetails.sentAmt.amount - paymentDetails.receivedAmt.amount
  const usdLiability = toUSD(liability) 
  const flashFee = Number(paymentDetails.receivedAmt.amount) - usdLiability
  // const accountIds = await staticAccountIds()
  // if (accountIds instanceof Error) return accountIds

  let entry = MainBook
    .entry(`User cash out from wallet ${userWalletD.id}`)
    .debit(`Cash`, Number(paymentDetails.receivedAmt.amount), { 
      type: LedgerTransactionType.Ibex_invoice,
      currency: paymentDetails.receivedAmt.currency,
      pending: false,
    }) 
    .credit(
      `Accounts Payable:${userWalletD.id}`,  // should be an id that represents user - not wallet
      usdLiability, 
      { 
        type: LedgerTransactionType.Ibex_invoice,
        amount: liability.amount,
        currency: liability.currency,
        pending: false, 
       }
    )
    .credit("Revenue", Number(flashFee), { 
        type: LedgerTransactionType.Ibex_invoice,
        currency: WalletCurrency.Usd,
        pending: false, 
       }
    ) 
    // .commit()
    return persistAndReturnEntry({ 
      entry, 
      // hash: metadata.hash 
    })
}

export const recordSettledCashOut = async ({
  ledgerTrxid,
  paymentDetails,
}: RecordCashOutSettledArgs) => {
  const ledgerTransaction = await LedgerService().getTransactionById(ledgerTrxid)
  if (ledgerTransaction instanceof LedgerError) return ledgerTransaction

  const userWalletId = ledgerTransaction.walletId
  if (userWalletId === undefined) return new LedgerServiceError("Could not find wallet id for transaction.")
  if (paymentDetails.sent.currency !== ledgerTransaction.currency) return new LedgerServiceError("Settled currency does not match liability currency.")


  const usdSent = toUSD(paymentDetails.sent)
  const metadata = { 
    type: LedgerTransactionType.JamaicanRtgs,
    transactionId: paymentDetails.transactionId,
    currency: paymentDetails.sent.currency,
    pending: false, 
  }
  let entry = MainBook
    .entry(`Rtgs bank transfer complete to user with wallet: ${userWalletId}`)
    .debit(`Accounts Payable:${userWalletId}`, usdSent, metadata) 
    .credit("Cash", usdSent, metadata)

  // Flash accounts for currency exchange rate volatility (e.g USD -> JMD) from cash out is issued to time rtgs transfer
  const foreignExchangeChange = usdSent - (ledgerTransaction.usd || usdSent)
  if (foreignExchangeChange > 0) {
    entry
      .debit("Foreign Exchange", foreignExchangeChange)
      .credit(`Accounts Payable:${userWalletId}`, foreignExchangeChange)
  } else if (foreignExchangeChange < 0) {
    entry
      .debit(`Accounts Payable:${userWalletId}`, foreignExchangeChange)
      .credit("Foreign Exchange", foreignExchangeChange)
  }

  return persistAndReturnEntry({ 
    entry, 
  })
}

// Get Accounts Payable for the given currency
export const getAccountsPayable = async <T extends WalletCurrency>(currency: T): Promise<Amount<T>> => {
  return {
    amount: BigInt((await MainBook.balance({ account: ["Accounts Payable", currency]})).balance),
    currency: currency,
  }
}

// If no currency is provided, returns Accounts Payable for all currencies denominated in USD
export const getTotalAccountsPayable = async (): Promise<Amount<"USD">> => {
  return {
    amount: BigInt((await MainBook.balance({ account: ["Accounts Payable"]})).balance),
    currency: WalletCurrency.Usd,
  }
}