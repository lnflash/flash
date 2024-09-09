import { memoSharingConfig } from "@config"
import { PartialResult } from "@app/partial-result"

import { LedgerError } from "@domain/ledger"
import { WalletTransactionHistory } from "@domain/wallets"
import { CouldNotFindError } from "@domain/errors"

import { getNonEndUserWalletIds, LedgerService } from "@services/ledger"
import { WalletOnChainPendingReceiveRepository } from "@services/mongoose"
import { client as Ibex } from "@services/ibex"
import { IbexApiError, IbexClientError } from "@services/ibex/client/errors"
import { GResponse200 } from "@services/ibex/client/.api/apis/sing-in/types"
import { baseLogger } from "@services/logger"

export const getTransactionsForWallets = async ({
  wallets,
  paginationArgs,
}: {
  wallets: Wallet[]
  paginationArgs?: PaginationArgs
}): Promise<PartialResult<PaginatedArray<IbexTransaction>>> => {
  const walletIds = wallets.map((wallet) => wallet.id)

  // Flash fork: return history from Ibex
  const ibexCalls = await Promise.all(walletIds
    .map(id => Ibex().getAccountTransactions({ 
      account_id: id,
    }))
  )

  const transactions = ibexCalls.flatMap(resp => {
    if (resp instanceof IbexClientError) return [] 
    else return toWalletTransactions(resp)
  })

  return PartialResult.ok({
    slice: transactions,
    total: transactions.length
  })
}

export const toWalletTransactions = (ibexResp: GResponse200): IbexTransaction[] => {
  return ibexResp.map(trx => {
    const currency = (trx.currencyId === 3 ? "USD" : "BTC") as WalletCurrency // WalletCurrency: "USD" | "BTC",

    const settlementDisplayPrice: WalletMinorUnitDisplayPrice<WalletCurrency, DisplayCurrency> = {
      base: trx.exchangeRateCurrencySats ? BigInt(Math.floor(trx.exchangeRateCurrencySats)) : 0n,
      offset: 0n, // what is this?
      displayCurrency: "USD" as DisplayCurrency,
      walletCurrency: currency
    }

    const baseTrx: BaseWalletTransaction = {
      walletId: (trx.accountId || "") as WalletId, 
      settlementAmount: toSettlementAmount(trx.amount, trx.transactionTypeId, currency),
      settlementFee: asCurrency(trx.networkFee, currency),
      settlementCurrency: currency, 
      settlementDisplayAmount: `${trx.amount}`, 
      settlementDisplayFee: `${trx.networkFee}`, 
      settlementDisplayPrice: settlementDisplayPrice,
      createdAt: trx.createdAt ? new Date(trx.createdAt) : new Date(), // should always return
      id: trx.id || "null", // "LedgerTransactionId" - this is likely unused 
      status: "success" as TxStatus, // assuming Ibex returns on completed
      memo: null, // query transaction details
    }

    switch (trx.transactionTypeId) {
      case 1:
      case 2:
        return {
          ...baseTrx,
          // Ibex does not provide paymentHash, pubkey and preimage in transactions endpoint. To get these fields,
          // we need to query the transaction details for each trx individually. 
          initiationVia: { type: 'lightning', paymentHash: "", pubkey: "" },
          settlementVia: { type: 'lightning', revealedPreImage: undefined }
        } as WalletLnSettledTransaction
      case 3:
      case 4:
        return {
          ...baseTrx,
          // Ibex does not provide paymentHash, pubkey and preimage in transactions endpoint. To get these fields,
          // we need to query the transaction details for each trx individually. 
          initiationVia: { type: 'onchain', address: "" },
          settlementVia: { type: 'onchain', transactionHash: '', vout: undefined }
        } as WalletOnChainSettledTransaction // assuming Ibex only gives us settled
      default:
        baseLogger.error(`Failed to parse Ibex transaction type. { WalletId: ${baseTrx.walletId}, TransactionId: ${trx.id}, transactionTypeId: ${trx.transactionTypeId}`)
        return { 
          ...baseTrx,
          initiationVia: { type: 'unknown' },
          settlementVia: { type: 'unknown' }
        } as UnknownTypeTransaction
    }
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
  // When sending, make negative
  const amt = (transactionTypeId === 2 || transactionTypeId === 4) 
    ? -1 * ibexAmount 
    : ibexAmount
  return asCurrency(amt, currency)
}