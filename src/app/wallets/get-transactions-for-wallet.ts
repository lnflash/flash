import { memoSharingConfig } from "@config"
import { PartialResult } from "@app/partial-result"

import { LedgerError } from "@domain/ledger"
import { WalletTransactionHistory } from "@domain/wallets"
import { CouldNotFindError } from "@domain/errors"

import { getNonEndUserWalletIds, LedgerService } from "@services/ledger"
import { WalletOnChainPendingReceiveRepository } from "@services/mongoose"
import Ibex from "@services/ibex"
import { IbexApiError, IbexEventError } from "@services/ibex/errors"
import { GResponse200 } from "@services/ibex/.api/apis/sing-in/types"
import { baseLogger } from "@services/logger"

export const getTransactionsForWallets = async ({
  wallets,
  paginationArgs,
}: {
  wallets: Wallet[]
  paginationArgs?: PaginationArgs
}): Promise<PartialResult<PaginatedArray<WalletTransaction>>> => {
  const walletIds = wallets.map((wallet) => wallet.id)

  // Flash fork: return history from Ibex
  const ibexCalls = await Promise.all(walletIds
    .map(id => Ibex.getAccountTransactions({ 
      account_id: id,
    }))
  )

  const transactions = ibexCalls.flatMap(resp => {
    if (resp instanceof IbexEventError) return [] 
    else return toWalletTransactions(resp)
  })

  return PartialResult.ok({
    slice: transactions,
    total: transactions.length
  })
}

export const toWalletTransactions = (ibexResp: GResponse200): WalletTransaction[] => {
  return ibexResp.map(trx => {
    const currency = (trx.currencyId === 3 ? "USD" : "BTC") as WalletCurrency // WalletCurrency: "USD" | "BTC",

    const settlementDisplayPrice: WalletMinorUnitDisplayPrice<WalletCurrency, DisplayCurrency> = {
      base: trx.exchangeRateCurrencySats ? BigInt(Math.floor(trx.exchangeRateCurrencySats)) : 0n,
      offset: 0n, // what is this?
      displayCurrency: "USD" as DisplayCurrency,
      walletCurrency: currency
    }

    return {
      walletId: (trx.accountId || "") as WalletId, // WalletId | undefined
      settlementAmount: toSettlementAmount(trx.amount, trx.transactionTypeId, currency),
      settlementFee: asCurrency(trx.networkFee, currency),
      settlementCurrency: currency, 
      settlementDisplayAmount: `${trx.amount}`, // what should this be?
      settlementDisplayFee: `${trx.networkFee}`, // what should this be?
      settlementDisplayPrice: settlementDisplayPrice,
      createdAt: trx.createdAt ? new Date(trx.createdAt) : new Date(), // should always return
      id: trx.id || "null", // "LedgerTransactionId", // this can probably be removed
      status: "success" as TxStatus, // assuming Ibex returns on completed
      memo: null, // not provided by Ibex
      initiationVia: { type: "lightning", paymentHash: "", pubkey: "" },
      settlementVia: { type: "lightning", revealedPreImage: undefined }
    } as WalletLnSettledTransaction
  })
}

const asCurrency = (amount: number | undefined, currency: WalletCurrency): Satoshis | UsdCents => {
  return currency === "USD" ? amount as UsdCents : amount as Satoshis
}

const toSettlementAmount = (
  ibexAmount: number | undefined, 
  transactionTypeId: number | undefined, 
  currency: WalletCurrency
): Satoshis | UsdCents => {
  if (ibexAmount === undefined) {
    baseLogger.warn("Ibex did not return transaction amount")
    return asCurrency(ibexAmount, currency) 
  }
  const amt = (transactionTypeId === 2 || transactionTypeId === 4) 
    ? -1 * ibexAmount 
    : ibexAmount
  return asCurrency(amt, currency)
}