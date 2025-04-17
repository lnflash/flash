import {
  USDAmount,
} from "@domain/shared"
import { MainBook } from "./books"
import { persistAndReturnEntry } from "./helpers"
import { LedgerError, LedgerServiceError, LedgerTransactionType } from "@domain/ledger"
import { LedgerService } from "."
import { CashoutDetails, RtgsTransfer } from "@app/offers"

export type RecordCashOutSettledArgs = {
  ledgerTrxid: LedgerTransactionId,
  paymentDetails: RtgsTransfer,
}

// Medici accounts
const Accounts = {
  Payable: (id: WalletId) => ["Accounts Payable", id],
  Revenue: {
    ServiceFees: ["Revenue", "Service Fees"],
  },
  Ibex: (_: WalletId) => [`Ibex`, _],
  ForeignExchange: "Foreign Exchange"
}

const mediciNumber = (usd: USDAmount): number => Number(usd.asCents(2))

export const recordCashOut = async (
  offer: CashoutDetails,
): Promise<LedgerJournal | LedgerServiceError> => {
  const { ibexTrx, flash } = offer 
  const { liability, fee: flashFee } = flash

  let entry = MainBook
    .entry(`User cash out from wallet ${ibexTrx.userAcct}`)
    .debit(Accounts.Ibex(ibexTrx.flashAcct), 
      mediciNumber(ibexTrx.usd), 
      { 
        type: LedgerTransactionType.Ibex_invoice,
        currency: ibexTrx.usd.currencyCode,
        pending: false,
      }
    ) 
    .credit(
      Accounts.Payable(ibexTrx.userAcct),  // should be an id that represents user - not wallet
      mediciNumber(liability.usd), 
      { 
        type: LedgerTransactionType.Ibex_invoice,
        amount: liability.jmd.asCents(),
        currency: liability.jmd.currencyCode,
        pending: false, 
       }
    )
    .credit(Accounts.Revenue.ServiceFees, 
      mediciNumber(flashFee), 
      { 
        type: LedgerTransactionType.Ibex_invoice,
        currency: flashFee.currencyCode,
        pending: false, 
      }
    )

  return persistAndReturnEntry({ 
    entry, 
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
  if (paymentDetails.sent.currencyCode !== ledgerTransaction.currency) return new LedgerServiceError("Settled currency does not match liability currency.")


  const usdSent = paymentDetails.sent.asCents()
  const metadata = { 
    type: LedgerTransactionType.JamaicanRtgs,
    transactionId: paymentDetails.transactionId,
    currency: paymentDetails.sent.currencyCode,
    pending: false, 
  }
  let entry = MainBook
    .entry(`Rtgs bank transfer complete to user with wallet: ${userWalletId}`)
    .debit(Accounts.Payable(userWalletId), usdSent, metadata) 
    .credit("External Cash", usdSent, metadata)

  // Flash is exposed to exchange rate volatility (e.g USD -> JMD) when there is not enough JMD to cover current liabilities
  // const foreignExchangeChange = usdSent - (ledgerTransaction.usd || usdSent)
  // if (foreignExchangeChange > 0) {
  //   entry
  //     .debit("Foreign Exchange", foreignExchangeChange)
  //     .credit(`Accounts Payable:${userWalletId}`, foreignExchangeChange)
  // } else if (foreignExchangeChange < 0) {
  //   entry
  //     .debit(`Accounts Payable:${userWalletId}`, foreignExchangeChange)
  //     .credit("Foreign Exchange", foreignExchangeChange)
  // }

  return persistAndReturnEntry({ 
    entry, 
  })
}

// Create type for withdrawal transaction
// export const ibexWithdrawal = async (acct: IbexAccount, sent: PaymentAmount<"USD">, received: PaymentAmount<"USD">) => {
//   let entry = MainBook
//     .entry("Ibex Withdrawal")
//     .debit("External Cash", received.amount)
//     .debit(Accounts.Expenses.IbexFees, sent.amount - received.amount)
//     .credit(Accounts.Ibex(acct), sent.amount)
  
//   return persistAndReturnEntry({ 
//     entry, 
//   })
// }

// Get Accounts Payable for the given currency
// export const getAccountsPayable = async <T extends WalletCurrency>(currency: T): Promise<Amount<T>> => {
//   return {
//     amount: BigInt((await MainBook.balance({ account: ["Accounts Payable", currency]})).balance),
//     currency: currency,
//   }
// }

// // If no currency is provided, returns Accounts Payable for all currencies denominated in USD
// export const getTotalAccountsPayable = async (): Promise<Amount<"USD">> => {
//   return {
//     amount: BigInt((await MainBook.balance({ account: ["Accounts Payable"]})).balance),
//     currency: WalletCurrency.Usd,
//   }
// }