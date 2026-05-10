import { PartialResult } from "@app/partial-result"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { GResponse200 } from "ibex-client"
import { ConnectionArguments, ConnectionCursor } from "graphql-relay"
import { ExchangeRates } from "@config"
import {
  getCurrencyMajorExponent,
  SAT_PRICE_PRECISION_OFFSET,
  UsdDisplayCurrency,
  USD_PRICE_PRECISION_OFFSET,
} from "@domain/fiat"
import { WalletCurrency } from "@domain/shared"

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
    const currency = (trx.currencyId === 3 ? "USD" : "BTC") as WalletCurrency // WalletCurrency: "USD" | "BTC",
    const signedSettlementAmount = toSettlementAmount(
      trx.amount,
      trx.transactionTypeId,
      currency,
    )
    const settlementFee = asCurrency(trx.networkFee, currency)

    const settlementDisplayPrice: WalletMinorUnitDisplayPrice<
      WalletCurrency,
      DisplayCurrency
    > = {
      ...displayPriceFromMinorUnit({
        displayMinorPerWalletMinorUnit: displayMinorPerWalletMinorUnit({
          walletCurrency: currency,
          displayCurrency,
          usdMajorPerSat: trx.exchangeRateCurrencySats,
        }),
        displayCurrency,
        walletCurrency: currency,
      }),
    }

    const baseTrx: BaseWalletTransaction = {
      walletId: (trx.accountId || "") as WalletId,
      settlementAmount: signedSettlementAmount,
      settlementFee,
      settlementCurrency: currency,
      settlementDisplayAmount: toDisplayMajorAmount({
        walletAmount: signedSettlementAmount,
        walletCurrency: currency,
        displayCurrency,
        usdMajorPerSat: trx.exchangeRateCurrencySats,
      }),
      settlementDisplayFee: toDisplayMajorAmount({
        walletAmount: settlementFee,
        walletCurrency: currency,
        displayCurrency,
        usdMajorPerSat: trx.exchangeRateCurrencySats,
      }),
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
          initiationVia: { type: "lightning", paymentHash: "", pubkey: "" },
          settlementVia: { type: "lightning", revealedPreImage: undefined },
        } as WalletLnSettledTransaction
      case 3:
      case 4:
        return {
          ...baseTrx,
          // Ibex does not provide paymentHash, pubkey and preimage in transactions endpoint. To get these fields,
          // we need to query the transaction details for each trx individually.
          initiationVia: { type: "onchain", address: "" },
          settlementVia: { type: "onchain", transactionHash: "", vout: undefined },
        } as WalletOnChainSettledTransaction // assuming Ibex only gives us settled
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

const jmdCentsPerUsdDollar = () => Number(ExchangeRates.jmd.sell.asCents())

const displayPriceFromMinorUnit = <S extends WalletCurrency, T extends DisplayCurrency>({
  displayMinorPerWalletMinorUnit,
  displayCurrency,
  walletCurrency,
}: {
  displayMinorPerWalletMinorUnit: number
  displayCurrency: T
  walletCurrency: S
}): WalletMinorUnitDisplayPrice<S, T> => {
  const offset =
    walletCurrency === WalletCurrency.Btc
      ? SAT_PRICE_PRECISION_OFFSET
      : USD_PRICE_PRECISION_OFFSET

  return {
    base: BigInt(Math.round(displayMinorPerWalletMinorUnit * 10 ** offset)),
    offset: BigInt(offset),
    displayCurrency,
    walletCurrency,
  }
}

const displayMinorPerWalletMinorUnit = ({
  walletCurrency,
  displayCurrency,
  usdMajorPerSat,
}: {
  walletCurrency: WalletCurrency
  displayCurrency: DisplayCurrency
  usdMajorPerSat: number | undefined
}): number => {
  if (walletCurrency === WalletCurrency.Usd) {
    if (displayCurrency === UsdDisplayCurrency) return 1
    if (displayCurrency === WalletCurrency.Jmd) return jmdCentsPerUsdDollar() / 100
  }

  const usdPerSat = usdMajorPerSat ?? 0
  if (displayCurrency === WalletCurrency.Jmd) {
    return usdPerSat * jmdCentsPerUsdDollar()
  }

  const displayMajorExponent = getCurrencyMajorExponent(displayCurrency)
  return usdPerSat * 10 ** displayMajorExponent
}

const toDisplayMajorAmount = ({
  walletAmount,
  walletCurrency,
  displayCurrency,
  usdMajorPerSat,
}: {
  walletAmount: Satoshis | UsdCents
  walletCurrency: WalletCurrency
  displayCurrency: DisplayCurrency
  usdMajorPerSat: number | undefined
}): DisplayCurrencyMajorAmount => {
  const displayMajorExponent = getCurrencyMajorExponent(displayCurrency)
  const amount = Number(walletAmount ?? 0)
  let displayMinorAmount: number

  if (walletCurrency === WalletCurrency.Usd) {
    displayMinorAmount =
      displayCurrency === WalletCurrency.Jmd
        ? (amount * jmdCentsPerUsdDollar()) / 100
        : amount
  } else {
    displayMinorAmount =
      amount *
      displayMinorPerWalletMinorUnit({
        walletCurrency,
        displayCurrency,
        usdMajorPerSat,
      })
  }

  return (displayMinorAmount / 10 ** displayMajorExponent).toFixed(
    displayMajorExponent,
  ) as DisplayCurrencyMajorAmount
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
  // When sending, make negative
  const amt =
    transactionTypeId === 2 || transactionTypeId === 4 ? -1 * ibexAmount : ibexAmount
  return asCurrency(amt, currency)
}

enum SortOrder {
  RECENT = "settledAt",
  OLDEST = "-settledAt",
}

type IbexPaginationArgs = {
  page?: number | undefined // ibex default (0) start at page 0
  limit?: number | undefined // ibex default (0) returns all
  sort?: SortOrder | undefined // defaults to SortOrder.RECENT
}

export function toIbexPaginationArgs(
  args: ConnectionArguments | undefined,
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
