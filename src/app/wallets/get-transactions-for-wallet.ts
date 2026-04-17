import { PartialResult } from "@app/partial-result"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { GResponse200 } from "ibex-client"
import { ConnectionArguments } from "graphql-relay"
import { PriceService } from "@services/price"
import { PriceRange, PriceInterval } from "@domain/price"

// Cache for price history - fetched once and reused
let priceHistoryCache: Map<number, number> | null = null
let priceHistoryCacheTime = 0
const CACHE_TTL_MS = 60 * 1000 // 1 minute

const getHistoricalPriceAtTimestamp = async (
  timestamp: Date,
): Promise<number | null> => {
  const now = Date.now()

  // Refresh cache if expired
  if (!priceHistoryCache || now - priceHistoryCacheTime > CACHE_TTL_MS) {
    const priceService = PriceService()
    // Fetch last 90 days of price history (should cover most transactions)
    const history = await priceService.listHistory({
      range: PriceRange.ThreeMonths,
      interval: PriceInterval.OneDay,
    })

    if (history instanceof Error) {
      baseLogger.warn({ error: history }, "Failed to fetch price history for transaction display")
      return null
    }

    priceHistoryCache = new Map()
    for (const tick of history) {
      priceHistoryCache.set(tick.date.getTime(), tick.price)
    }
    priceHistoryCacheTime = now
  }

  const txTime = timestamp.getTime()

  // Find the closest tick to the transaction time
  let closestTime = 0
  let closestPrice = 0

  for (const [tickTime, tickPrice] of priceHistoryCache) {
    if (Math.abs(tickTime - txTime) < Math.abs(closestTime - txTime)) {
      closestTime = tickTime
      closestPrice = tickPrice
    }
  }

  return closestPrice || null
}

export const getTransactionsForWallets = async ({
  wallets,
  paginationArgs,
}: {
  wallets: Wallet[]
  paginationArgs?: PaginationArgs
}): Promise<PartialResult<PaginatedArray<IbexTransaction>>> => {
  const walletIds = wallets.map((wallet) => wallet.id)

  const ibexCalls = await Promise.all(
    walletIds.map((id) =>
      Ibex.getAccountTransactions({
        account_id: id,
        ...toIbexPaginationArgs(paginationArgs),
      }),
    ),
  )

  const transactions = ibexCalls.flatMap((resp) => {
    if (resp instanceof IbexError) return []
    return toWalletTransactions(resp)
  })

  return PartialResult.ok({
    slice: transactions,
    total: transactions.length,
  })
}

export const toWalletTransactions = async (
  ibexResp: GResponse200,
): Promise<IbexTransaction[]> => {
  const results: IbexTransaction[] = []

  for (const trx of ibexResp) {
    const currency = (
      trx.currencyId === 3 ? "USD" : "BTC"
    ) as WalletCurrency

    // Use historical price at the time of transaction instead of current rate
    let displayPriceBase = 0n
    if (trx.createdAt) {
      const historicalPrice = await getHistoricalPriceAtTimestamp(
        new Date(trx.createdAt),
      )
      if (historicalPrice) {
        // Convert DisplayCurrencyPerSat to base units (sats per display unit)
        displayPriceBase = BigInt(Math.round(1 / historicalPrice))
      }
    }

    // Fallback to Ibex rate if historical price unavailable
    if (displayPriceBase === 0n && trx.exchangeRateCurrencySats) {
      displayPriceBase = BigInt(Math.floor(trx.exchangeRateCurrencySats))
    }

    const settlementDisplayPrice: WalletMinorUnitDisplayPrice<
      WalletCurrency,
      DisplayCurrency
    > = {
      base: displayPriceBase,
      offset: 0n,
      displayCurrency: "USD" as DisplayCurrency,
      walletCurrency: currency,
    }

    const baseTrx: BaseWalletTransaction = {
      walletId: (trx.accountId || "") as WalletId,
      settlementAmount: toSettlementAmount(
        trx.amount,
        trx.transactionTypeId,
        currency,
      ),
      settlementFee: asCurrency(trx.networkFee, currency),
      settlementCurrency: currency,
      settlementDisplayAmount: `${trx.amount}`,
      settlementDisplayFee: `${trx.networkFee}`,
      settlementDisplayPrice: settlementDisplayPrice,
      createdAt: trx.createdAt ? new Date(trx.createdAt) : new Date(),
      id: trx.id || "null",
      status: "success" as TxStatus,
      memo: null,
    }

    switch (trx.transactionTypeId) {
      case 1:
      case 2:
        results.push({
          ...baseTrx,
          initiationVia: { type: "lightning", paymentHash: "", pubkey: "" },
          settlementVia: { type: "lightning", revealedPreImage: undefined },
        } as WalletLnSettledTransaction)
        break
      case 3:
      case 4:
        results.push({
          ...baseTrx,
          initiationVia: { type: "onchain", address: "" },
          settlementVia: {
            type: "onchain",
            transactionHash: "",
            vout: undefined,
          },
        } as WalletOnChainSettledTransaction)
        break
      default:
        baseLogger.error(
          `Failed to parse Ibex transaction type. { WalletId: ${baseTrx.walletId}, TransactionId: ${trx.id}, transactionTypeId: ${trx.transactionTypeId}`,
        )
        results.push({
          ...baseTrx,
          initiationVia: { type: "unknown" },
          settlementVia: { type: "unknown" },
        } as UnknownTypeTransaction)
    }
  }

  return results
}

const asCurrency = (
  amount: number | undefined,
  currency: WalletCurrency,
): Satoshis | UsdCents => {
  return currency === "USD" ? (amount as UsdCents) : (amount as Satoshis)
}

const toSettlementAmount = (
  ibexAmount: number | undefined,
  transactionTypeId: number | undefined,
  currency: WalletCurrency,
): Satoshis | UsdCents => {
  if (ibexAmount === undefined) {
    baseLogger.warn("Ibex did not return transaction amount")
    return asCurrency(ibexAmount, currency)
  }
  const amt =
    transactionTypeId === 2 || transactionTypeId === 4
      ? -1 * ibexAmount
      : ibexAmount
  return asCurrency(amt, currency)
}

enum SortOrder {
  RECENT = "settledAt",
  OLDEST = "-settledAt",
}

type IbexPaginationArgs = {
  page?: number | undefined
  limit?: number | undefined
  sort?: SortOrder | undefined
}

export function toIbexPaginationArgs(
  args: ConnectionArguments | undefined,
): IbexPaginationArgs {
  const DEFAULTS = {
    page: 0,
    limit: 0,
    sort: SortOrder.RECENT,
  }

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
