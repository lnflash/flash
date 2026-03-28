import { PartialResult } from "@app/partial-result"
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

export const toWalletTransactions = (ibexResp: GResponse200): IbexTransaction[] => {
  return ibexResp.map(trx => {
    const currency = (trx.currencyId === 3 ? "USD" : "BTC") as WalletCurrency // WalletCurrency: "USD" | "BTC",

    // FIXME: displayCurrency should come from user preferences, not hardcoded USD
    // See: https://github.com/lnflash/flash/issues/282
    const displayCurrency: DisplayCurrency = "USD"
    const settlementDisplayPrice: WalletMinorUnitDisplayPrice<WalletCurrency, DisplayCurrency> = {
      // Use Math.round instead of Math.floor to avoid truncating sub-unit JMD amounts to 0
      // Note: trx.exchangeRateCurrencySats interpretation may need review (see bounty issue)
      base: trx.exchangeRateCurrencySats ? BigInt(Math.round(trx.exchangeRateCurrencySats)) : 0n,
      // offset is set to 0 here because exchangeRateCurrencySats may already embed the exponent
      // TODO: verify exchangeRateCurrencySats unit from Ibex API (sats vs sats*10^offset)
      offset: 0n,
      displayCurrency,
      walletCurrency: currency
    }

    const baseTrx: BaseWalletTransaction = {
      walletId: (trx.accountId || "") as WalletId, 
      settlementAmount: toSettlementAmount(trx.amount, trx.transactionTypeId, currency),
      settlementFee: asCurrency(trx.networkFee, currency),
      settlementCurrency: currency, 
      // FIXME: settlementDisplayAmount should be converted to displayCurrency, not raw wallet amount
      // Currently for JMD users, this shows USD amounts (wallet currency) instead of JMD
      // See: https://github.com/lnflash/flash/issues/282
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
