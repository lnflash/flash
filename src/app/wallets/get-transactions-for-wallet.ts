import { PartialResult } from "@app/partial-result"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { GResponse200 } from "ibex-client"
import { ConnectionArguments, ConnectionCursor } from "graphql-relay"

export const getTransactionsForWallets = async ({
  wallets,
  paginationArgs,
}: {
  wallets: Wallet[]
  paginationArgs?: PaginationArgs
}): Promise<PartialResult<PaginatedArray<IbexTransaction>>> => {
  const walletIds = wallets.map((wallet) => wallet.id)
  
  const ibexCalls = await Promise.all(walletIds
    .map(id => Ibex.getAccountTransactions({ 
      account_id: id,
      ...toIbexPaginationArgs(paginationArgs)
    }))
  )

  const transactions = ibexCalls.flatMap(resp => {
    if (resp instanceof IbexError) return [] 
    else return toWalletTransactions(resp)
  })

  return PartialResult.ok({
    slice: transactions,
    total: transactions.length
  })
}

const currencyFromIbexCurrencyId = (currencyId: number | undefined): WalletCurrency | undefined => {
  if (currencyId === USDAmount.currencyId) return WalletCurrency.Usd
  if (currencyId === USDTAmount.currencyId) return WalletCurrency.Usdt
  return undefined
}

export const toWalletTransactions = (ibexResp: GResponse200): IbexTransaction[] => {
  return ibexResp.map(trx => {
    const currency = currencyFromIbexCurrencyId(trx.currencyId)

    if (!currency) {
      baseLogger.error(`Failed to parse Ibex transaction currency. { WalletId: ${trx.accountId}, TransactionId: ${trx.id}, currencyId: ${trx.currencyId} }`)
      return {
        walletId: (trx.accountId || "") as WalletId,
        settlementAmount: 0 as Satoshis,
        settlementFee: 0 as Satoshis,
        settlementCurrency: WalletCurrency.Usd,
        settlementDisplayAmount: `${trx.amount}`,
        settlementDisplayFee: `${trx.networkFee}`,
        settlementDisplayPrice: {
          base: 0n,
          offset: 0n,
          displayCurrency: "USD" as DisplayCurrency,
          walletCurrency: WalletCurrency.Usd,
        },
        createdAt: trx.createdAt ? new Date(trx.createdAt) : new Date(),
        id: trx.id || "null",
        status: "success" as TxStatus,
        memo: null,
        initiationVia: { type: "unknown" },
        settlementVia: { type: "unknown" },
      } as UnknownTypeTransaction
    }

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

enum SortOrder {
  RECENT = "settledAt",
  OLDEST = "-settledAt"
}

type IbexPaginationArgs = {
  page?: number | undefined; // ibex default (0) start at page 0
  limit?: number | undefined; // ibex default (0) returns all
  sort?: SortOrder | undefined; // defaults to SortOrder.RECENT
}

export function toIbexPaginationArgs(
  args: ConnectionArguments | undefined
): IbexPaginationArgs {
  const DEFAULTS = {
    page: 0, 
    limit: 0, 
    sort: SortOrder.RECENT, 
  }

  // Prefer 'first' over 'last')
  if (args && args.first != null) {
    return {
      ...DEFAULTS,
      limit: args.first,
      sort: SortOrder.RECENT, 
    }
  } else if (args && args.last != null) {
    return {
      ...DEFAULTS,
      limit: args.last,
      sort: SortOrder.OLDEST, 
    }
  } else return DEFAULTS
}
