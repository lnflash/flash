import { PartialResult } from "@app/partial-result"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { GResponse200 } from "ibex-client"
import { ConnectionArguments, ConnectionCursor } from "graphql-relay"

import { ExchangeRates } from "@config"
import {
  SAT_PRICE_PRECISION_OFFSET,
  USD_PRICE_PRECISION_OFFSET,
  UsdDisplayCurrency,
  JmdDisplayCurrency,
} from "@domain/fiat"
import { BigIntConversionError, WalletCurrency } from "@domain/shared"

export const getTransactionsForWallets = async ({
  wallets,
  paginationArgs,
  displayCurrency = UsdDisplayCurrency,
}: {
  wallets: Wallet[]
  paginationArgs?: PaginationArgs
  displayCurrency?: DisplayCurrency
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
    else return toWalletTransactions(resp, displayCurrency)
  })

  return PartialResult.ok({
    slice: transactions,
    total: transactions.length,
  })
}

export const toWalletTransactions = (
  ibexResp: GResponse200,
  displayCurrency: DisplayCurrency = UsdDisplayCurrency,
): IbexTransaction[] => {
  return ibexResp.map((trx) => {
    const currency = (trx.currencyId === 3 ? "USD" : "BTC") as WalletCurrency

    // Determine the correct price precision offset based on wallet currency
    const priceOffset =
      currency === WalletCurrency.Btc
        ? SAT_PRICE_PRECISION_OFFSET
        : USD_PRICE_PRECISION_OFFSET

    // Round instead of floor to avoid truncating small exchange rates to 0
    const exchangeRateBase = trx.exchangeRateCurrencySats
      ? BigInt(Math.round(trx.exchangeRateCurrencySats * 10 ** priceOffset))
      : 0n

    const settlementDisplayPrice: WalletMinorUnitDisplayPrice<
      WalletCurrency,
      DisplayCurrency
    > = {
      base: exchangeRateBase,
      offset: BigInt(priceOffset),
      displayCurrency,
      walletCurrency: currency,
    }

    // For JMD display currency, convert settlement amounts using the static rate
    let settlementDisplayAmount = `${trx.amount}`
    let settlementDisplayFee = `${trx.networkFee}`

    if (
      displayCurrency === JmdDisplayCurrency &&
      trx.amount !== undefined
    ) {
      const sellRate = ExchangeRates.jmd.sell
      if (!(sellRate instanceof BigIntConversionError)) {
        const usdCents = trx.amount
        const jmdCents = Number(sellRate.asCents()) / 100 * usdCents
        settlementDisplayAmount = String(Math.round(jmdCents))

        if (trx.networkFee !== undefined) {
          const feeJmdCents = Number(sellRate.asCents()) / 100 * trx.networkFee
          settlementDisplayFee = String(Math.round(feeJmdCents))
        }
      }
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
      settlementDisplayAmount,
      settlementDisplayFee,
      settlementDisplayPrice,
      createdAt: trx.createdAt ? new Date(trx.createdAt) : new Date(),
      id: trx.id || "null",
      status: "success" as TxStatus,
      memo: null,
    }

    switch (trx.transactionTypeId) {
      case 1:
      case 2:
        return {
          ...baseTrx,
          initiationVia: {
            type: "lightning",
            paymentHash: "",
            pubkey: "",
          },
          settlementVia: {
            type: "lightning",
            revealedPreImage: undefined,
          },
        } as WalletLnSettledTransaction
      case 3:
      case 4:
        return {
          ...baseTrx,
          initiationVia: { type: "onchain", address: "" },
          settlementVia: {
            type: "onchain",
            transactionHash: "",
            vout: undefined,
          },
        } as WalletOnChainSettledTransaction
      default:
        baseLogger.error(
          `Failed to parse Ibex transaction type. { WalletId: ${baseTrx.walletId}, TransactionId: ${trx.id}, transactionTypeId: ${trx.transactionTypeId}`,
        )
        return {
          ...baseTrx,
          initiationVia: { type: "unknown" },
          settlementVia: { type: "unknown" },
        } as UnknownTypeTransaction
    }
  })
}

const asCurrency = (
  amount: number | undefined,
  currency: WalletCurrency,
): Satoshis | UsdCents => {
  return currency === "USD"
    ? (amount as UsdCents)
    : (amount as Satoshis)
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
