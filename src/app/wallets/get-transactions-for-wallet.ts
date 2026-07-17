import { PartialResult } from "@app/partial-result"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { GResponse200 } from "ibex-client"
import { ConnectionArguments } from "graphql-relay"

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
    else return toWalletTransactions(resp)
  })

  return PartialResult.ok({
    slice: transactions,
    total: transactions.length,
  })
}

const currencyFromIbexCurrencyId = (
  currencyId: number | undefined,
): WalletCurrency | undefined => {
  if (currencyId === USDAmount.currencyId) return WalletCurrency.Usd
  if (currencyId === USDTAmount.currencyId) return WalletCurrency.Usdt
  return undefined
}

export const toWalletTransactions = (ibexResp: GResponse200): IbexTransaction[] => {
  return ibexResp.flatMap((trx) => {
    const currency = currencyFromIbexCurrencyId(trx.currencyId)

    if (!currency) {
      baseLogger.error(
        `Failed to parse Ibex transaction currency. Excluding transaction from list. { WalletId: ${trx.accountId}, TransactionId: ${trx.id}, currencyId: ${trx.currencyId} }`,
      )
      // A row with an unrecognized currency cannot be represented truthfully;
      // excluding it beats fabricating a USD row or emitting a source the
      // NonNull initiationVia/settlementVia unions cannot resolve (which fails
      // the whole transaction list query for the account).
      return []
    }

    const settlementDisplayPrice: WalletMinorUnitDisplayPrice<
      WalletCurrency,
      DisplayCurrency
    > = {
      base: trx.exchangeRateCurrencySats
        ? BigInt(Math.floor(trx.exchangeRateCurrencySats))
        : 0n,
      offset: 0n, // what is this?
      displayCurrency: "USD" as DisplayCurrency,
      walletCurrency: currency,
    }

    const baseTrx: BaseWalletTransaction = {
      walletId: (trx.accountId || "") as WalletId,
      settlementAmount: toSettlementAmount(trx.amount, trx.transactionTypeId, currency),
      settlementFee: toSettlementMinorUnit(trx.networkFee, currency),
      settlementCurrency: currency,
      settlementDisplayAmount: toSettlementDisplayAmount(
        trx.amount,
        trx.transactionTypeId,
      ),
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
          initiationVia: { type: "lightning", paymentHash: "", pubkey: "" },
          settlementVia: { type: "lightning", revealedPreImage: undefined },
        } as WalletLnSettledTransaction
      // IBEX type ids per GET /v2/transaction-types/all: 1/2 Lightning
      // receive/send, 3/4 On-Chain receive/send, 5 Fund, 6 Defund, 7 Bank
      // Deposit, 8 Bank Withdrawal, 9/10 Crypto receive/send (USDT), 11/12
      // Taproot receive/send. Bank/funding ops (5-8) are org-level and
      // intentionally left to the logged fallback below.
      case 3:
      case 4:
      case 9:
      case 10:
      case 11:
      case 12:
        return {
          ...baseTrx,
          // Ibex does not provide paymentHash, pubkey and preimage in transactions endpoint. To get these fields,
          // we need to query the transaction details for each trx individually.
          initiationVia: { type: "onchain", address: "" },
          settlementVia: { type: "onchain", transactionHash: "", vout: undefined },
        } as WalletOnChainSettledTransaction // assuming Ibex only gives us settled
      default:
        baseLogger.error(
          `Failed to parse Ibex transaction type. Rendering as intraledger. { WalletId: ${baseTrx.walletId}, TransactionId: ${trx.id}, transactionTypeId: ${trx.transactionTypeId} }`,
        )
        // Amounts and currency are valid even when the IBEX type id is not
        // recognized; render as a generic intraledger transaction (all union
        // fields nullable) rather than hiding money movement or emitting a
        // source the unions cannot resolve. Accepted caveat: the sign
        // convention (send = negative) is only known for recognized type ids,
        // so an unrecognized send type renders positive until its id is
        // added to the switch above.
        return {
          ...baseTrx,
          initiationVia: {
            type: "intraledger",
            counterPartyWalletId: undefined,
            counterPartyUsername: undefined,
          },
          settlementVia: {
            type: "intraledger",
            counterPartyWalletId: undefined,
            counterPartyUsername: null,
          },
        } as IntraLedgerTransaction
    }
  })
}

type SettlementMinorUnitAmount = Satoshis | UsdCents | UsdtCents

const toUsdtCents = (amount: number): UsdtCents => {
  const usdtAmount = USDTAmount.fromNumber(amount.toString())
  if (usdtAmount instanceof Error) {
    baseLogger.error({ err: usdtAmount, amount }, "Failed to parse IBEX USDT amount")
    return 0 as UsdtCents
  }
  return Number(usdtAmount.asUsdCents()) as UsdtCents
}

const zeroSettlementMinorUnit = (currency: WalletCurrency): SettlementMinorUnitAmount => {
  if (currency === WalletCurrency.Usd) return 0 as UsdCents
  if (currency === WalletCurrency.Usdt) return 0 as UsdtCents
  return 0 as Satoshis
}

const toSettlementMinorUnit = (
  amount: number | undefined,
  currency: WalletCurrency,
): SettlementMinorUnitAmount => {
  if (amount === undefined) return zeroSettlementMinorUnit(currency)
  if (currency === WalletCurrency.Usd) return amount as UsdCents
  if (currency === WalletCurrency.Usdt) return toUsdtCents(amount)
  return amount as Satoshis
}

// Sends render negative: Lightning send (2), On-Chain send (4), Crypto send
// (10), Taproot send (12).
const IBEX_SEND_TYPE_IDS = [2, 4, 10, 12]

const isIbexSendType = (transactionTypeId: number | undefined): boolean =>
  transactionTypeId !== undefined && IBEX_SEND_TYPE_IDS.includes(transactionTypeId)

const toSettlementAmount = (
  ibexAmount: number | undefined,
  transactionTypeId: number | undefined,
  currency: WalletCurrency,
): SettlementMinorUnitAmount => {
  if (ibexAmount === undefined) {
    baseLogger.warn("Ibex did not return transaction amount")
    return toSettlementMinorUnit(ibexAmount, currency)
  }
  const amt = isIbexSendType(transactionTypeId) ? -1 * ibexAmount : ibexAmount
  return toSettlementMinorUnit(amt, currency)
}

const toSettlementDisplayAmount = (
  ibexAmount: number | undefined,
  transactionTypeId: number | undefined,
): string => {
  if (ibexAmount === undefined) return `${ibexAmount}`
  const amount = isIbexSendType(transactionTypeId) ? -1 * ibexAmount : ibexAmount
  return `${amount}`
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
