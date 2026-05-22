import { PartialResult } from "@app/partial-result"
import { ExchangeRates } from "@config"
import {
  getCurrencyMajorExponent,
  SAT_PRICE_PRECISION_OFFSET,
  USD_PRICE_PRECISION_OFFSET,
  UsdDisplayCurrency,
} from "@domain/fiat"
import { WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import { GResponse200 } from "ibex-client"
import { ConnectionArguments } from "graphql-relay"

export const getTransactionsForWallets = async ({
  wallets,
  paginationArgs,
}: {
  wallets: Wallet[]
  paginationArgs?: PaginationArgs
}): Promise<PartialResult<PaginatedArray<IbexTransaction>>> => {
  const accounts = AccountsRepository()

  const ibexCalls = await Promise.all(
    wallets.map(async (wallet) => {
      const [account, transactions] = await Promise.all([
        accounts.findById(wallet.accountId),
        Ibex.getAccountTransactions({
          account_id: wallet.id,
          ...toIbexPaginationArgs(paginationArgs),
        }),
      ])

      return {
        displayCurrency:
          account instanceof Error ? UsdDisplayCurrency : account.displayCurrency,
        transactions,
      }
    }),
  )

  const transactions = ibexCalls.flatMap(({ displayCurrency, transactions }) => {
    if (transactions instanceof IbexError) return []
    else return toWalletTransactions(transactions, displayCurrency)
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
    const currency = (
      trx.currencyId === 3 ? WalletCurrency.Usd : WalletCurrency.Btc
    ) as WalletCurrency

    const settlementAmount = toSettlementAmount(
      trx.amount,
      trx.transactionTypeId,
      currency,
    )
    const settlementFee = toFeeAmount(trx.networkFee, currency)
    const settlementDisplayAmount = toSettlementDisplayAmount({
      amount: trx.amount,
      transactionTypeId: trx.transactionTypeId,
      walletCurrency: currency,
      displayCurrency,
      exchangeRateCurrencySats: trx.exchangeRateCurrencySats,
    })
    const settlementDisplayFee = toSettlementDisplayAmount({
      amount: trx.networkFee,
      transactionTypeId: 1,
      walletCurrency: currency,
      displayCurrency,
      exchangeRateCurrencySats: trx.exchangeRateCurrencySats,
    })

    const baseTrx: BaseWalletTransaction = {
      walletId: (trx.accountId || "") as WalletId,
      settlementAmount,
      settlementFee,
      settlementCurrency: currency,
      settlementDisplayAmount,
      settlementDisplayFee,
      settlementDisplayPrice: settlementDisplayPriceFromAmounts({
        displayAmount: settlementDisplayAmount,
        walletAmount: settlementAmount,
        walletCurrency: currency,
        displayCurrency,
      }),
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

const JMD_DISPLAY_CURRENCY = WalletCurrency.Jmd as DisplayCurrency

const amountToNumber = (amount: number | undefined): number => {
  if (amount === undefined) {
    baseLogger.warn("Ibex did not return transaction amount")
    return 0
  }

  return Number(amount)
}

const isDebit = (transactionTypeId: number | undefined): boolean =>
  transactionTypeId === 2 || transactionTypeId === 4

const toSignedAmount = (amount: number, transactionTypeId: number | undefined): number =>
  isDebit(transactionTypeId) ? -amount : amount

const toCurrencyAmount = (
  amount: number,
  currency: WalletCurrency,
): Satoshis | UsdCents => {
  return currency === WalletCurrency.Usd ? (amount as UsdCents) : (amount as Satoshis)
}

const toFeeAmount = (
  ibexAmount: number | undefined,
  currency: WalletCurrency,
): Satoshis | UsdCents => {
  const amount = amountToNumber(ibexAmount)
  const minorUnitAmount =
    currency === WalletCurrency.Usd ? Math.round(amount * 100) : Math.round(amount)
  return toCurrencyAmount(minorUnitAmount, currency)
}

const toSettlementAmount = (
  ibexAmount: number | undefined,
  transactionTypeId: number | undefined,
  currency: WalletCurrency,
): Satoshis | UsdCents => {
  const amount = amountToNumber(ibexAmount)
  const minorUnitAmount =
    currency === WalletCurrency.Usd ? Math.round(amount * 100) : Math.round(amount)

  return toCurrencyAmount(toSignedAmount(minorUnitAmount, transactionTypeId), currency)
}

const usdMajorToDisplayMajor = (
  usdMajorAmount: number,
  displayCurrency: DisplayCurrency,
): number => {
  if (displayCurrency === JMD_DISPLAY_CURRENCY) {
    return usdMajorAmount * Number(ExchangeRates.jmd.sell.asDollars())
  }

  return usdMajorAmount
}

const btcMinorToUsdMajor = (
  satsAmount: number,
  exchangeRateCurrencySats?: number,
): number => satsAmount * (exchangeRateCurrencySats || 0)

const formatDisplayMajorAmount = (
  amount: number,
  displayCurrency: DisplayCurrency,
): DisplayCurrencyMajorAmount => {
  const exponent = getCurrencyMajorExponent(displayCurrency)
  return amount.toFixed(exponent) as DisplayCurrencyMajorAmount
}

const toSettlementDisplayAmount = ({
  amount,
  transactionTypeId,
  walletCurrency,
  displayCurrency,
  exchangeRateCurrencySats,
}: {
  amount: number | undefined
  transactionTypeId: number | undefined
  walletCurrency: WalletCurrency
  displayCurrency: DisplayCurrency
  exchangeRateCurrencySats?: number
}): DisplayCurrencyMajorAmount => {
  const signedAmount = toSignedAmount(amountToNumber(amount), transactionTypeId)
  const usdMajorAmount =
    walletCurrency === WalletCurrency.Usd
      ? signedAmount
      : btcMinorToUsdMajor(signedAmount, exchangeRateCurrencySats)

  return formatDisplayMajorAmount(
    usdMajorToDisplayMajor(usdMajorAmount, displayCurrency),
    displayCurrency,
  )
}

const settlementDisplayPriceFromAmounts = ({
  displayAmount,
  walletAmount,
  walletCurrency,
  displayCurrency,
}: {
  displayAmount: DisplayCurrencyMajorAmount
  walletAmount: Satoshis | UsdCents
  walletCurrency: WalletCurrency
  displayCurrency: DisplayCurrency
}): WalletMinorUnitDisplayPrice<WalletCurrency, DisplayCurrency> => {
  const offset =
    walletCurrency === WalletCurrency.Btc
      ? SAT_PRICE_PRECISION_OFFSET
      : USD_PRICE_PRECISION_OFFSET
  const displayMajorExponent = getCurrencyMajorExponent(displayCurrency)
  const displayAmountInMinor = Math.round(
    Math.abs(Number(displayAmount)) * 10 ** displayMajorExponent,
  )
  const walletAmountAbs = Math.abs(Number(walletAmount))
  const priceInMinorUnit =
    walletAmountAbs === 0 ? 0 : displayAmountInMinor / walletAmountAbs

  return {
    base: BigInt(Math.round(priceInMinorUnit * 10 ** offset)),
    offset: BigInt(offset),
    displayCurrency,
    walletCurrency,
  }
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
