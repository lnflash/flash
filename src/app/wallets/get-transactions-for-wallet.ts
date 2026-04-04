import { PartialResult } from "@app/partial-result"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { GResponse200 } from "ibex-client"
import { ConnectionArguments, ConnectionCursor } from "graphql-relay"
import { ExchangeRates } from "@config"
import { WalletCurrency } from "@domain/shared"
import { CENTS_PER_USD, UsdDisplayCurrency } from "@domain/fiat"

export const getTransactionsForWallets = async ({
  wallets,
  paginationArgs,
  displayCurrency,
}: {
  wallets: Wallet[]
  paginationArgs?: PaginationArgs
  displayCurrency?: DisplayCurrency
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
    else return toWalletTransactions(resp, displayCurrency)
  })

  return PartialResult.ok({
    slice: transactions,
    total: transactions.length
  })
}

export const toWalletTransactions = (
  ibexResp: GResponse200,
  displayCurrency?: DisplayCurrency,
): IbexTransaction[] => {
  return ibexResp.map(trx => {
    const currency = (trx.currencyId === 3 ? "USD" : "BTC") as WalletCurrency // WalletCurrency: "USD" | "BTC",
    const resolvedDisplayCurrency = displayCurrency || "USD" as DisplayCurrency

    // Compute offset: BTC wallets use 8 (sats), USD wallets use 6 (cents)
    const priceOffset = currency === WalletCurrency.Btc ? 8n : 6n
    // Convert exchange rate from per-BTC to per-unit
    const exchangeRateBase = trx.exchangeRateCurrencySats 
      ? BigInt(Math.round(trx.exchangeRateCurrencySats * 10 ** Number(priceOffset)))
      : 0n

    const settlementDisplayPrice: WalletMinorUnitDisplayPrice<WalletCurrency, DisplayCurrency> = {
      base: exchangeRateBase,
      offset: priceOffset,
      displayCurrency: resolvedDisplayCurrency,
      walletCurrency: currency
    }

    // Compute settlementDisplayAmount from theIbex amount and exchange rate
    const settlementDisplayAmount = computeSettlementDisplayAmount({
      ibexAmount: trx.amount,
      currency,
      displayCurrency: resolvedDisplayCurrency,
      exchangeRateCurrencySats: trx.exchangeRateCurrencySats,
    })
    const settlementDisplayFee = computeSettlementDisplayAmount({
      ibexAmount: trx.networkFee,
      currency,
      displayCurrency: resolvedDisplayCurrency,
      exchangeRateCurrencySats: trx.exchangeRateCurrencySats,
    })

    const baseTrx: BaseWalletTransaction = {
      walletId: (trx.accountId || "") as WalletId, 
      settlementAmount: toSettlementAmount(trx.amount, trx.transactionTypeId, currency),
      settlementFee: asCurrency(trx.networkFee, currency),
      settlementCurrency: currency, 
      settlementDisplayAmount, 
      settlementDisplayFee, 
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

const computeSettlementDisplayAmount = ({
  ibexAmount,
  currency,
  displayCurrency,
  exchangeRateCurrencySats,
}: {
  ibexAmount: number | undefined
  currency: WalletCurrency
  displayCurrency: DisplayCurrency
  exchangeRateCurrencySats: number | undefined
}): string => {
  if (ibexAmount === undefined || ibexAmount === 0) return "0"

  // If display currency matches wallet currency, no conversion needed
  if (
    (currency === WalletCurrency.Btc && displayCurrency === "BTC") ||
    (currency === WalletCurrency.Usd && displayCurrency === UsdDisplayCurrency)
  ) {
    return `${ibexAmount}`
  }

  // For BTC wallet with non-BTC display currency, useIbex exchange rate
  if (currency === WalletCurrency.Btc && exchangeRateCurrencySats && exchangeRateCurrencySats > 0) {
    // exchangeRateCurrencySats is the display price per BTC
    // Convert from per-BTC to per-satoshi
    const ratePerSat = exchangeRateCurrencySats / 1e8
    return `${ibexAmount * ratePerSat}`
  }

  // For USD wallet with JMD display currency, use static exchange rate
  if (currency === WalletCurrency.Usd && displayCurrency === "JMD") {
    // ExchangeRates.jmd.sell is in JMD cents per USD cent
    // To convert USD cents to JMD cents: USD_cents * ExchangeRates.jmd.sell / 100
    const jmdCents = ibexAmount * Number(ExchangeRates.jmd.sell) / CENTS_PER_USD
    return `${jmdCents}`
  }

  // Fallback: no conversion
  return `${ibexAmount}`
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
