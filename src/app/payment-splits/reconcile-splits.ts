import { PaymentSplitsConfig } from "@config"

import { splitReconcileWindowMs } from "@domain/payment-splits"

import Ibex from "@services/ibex/client"
import { baseLogger } from "@services/logger"
import { WalletsRepository } from "@services/mongoose"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"

import { recordSplitExecutions } from "./record-split-executions"

const logger = baseLogger.child({ module: "payment-splits-reconcile" })

// IBEX transaction type ids (GET /v2/transaction-types/all).
const IBEX_LIGHTNING_RECEIVE = 1
// Type 9 (crypto receive: USDT on Ethereum) deliberately does NOT trigger in
// v1. Bridge virtual-account deposits arrive as the same type on the same
// address, so a split could not tell them apart (ENG-653 decision 2).

// Transactions read per IBEX page. Pages are read newest-settled first until
// one reaches past the lookback, so a busy wallet is covered whatever its
// receive rate; MAX_PAGES only stops a runaway loop (50k transactions).
const TRANSACTIONS_PAGE_SIZE = 100
const MAX_PAGES = 500

const PaymentHashRegex = /^[0-9a-f]{64}$/i

export type ReconcileSplitsSummary = {
  windowMs: number
  wallets: number
  receivesSeen: number
  recorded: number
  errors: number
}

type IbexAccountTransaction = {
  id?: string
  createdAt?: string
  amount?: number
  transactionTypeId?: number
}

/**
 * Every transaction on `walletId` from the newest back to `since`, one IBEX
 * page at a time (sort settledAt: newest settled first; pages are 0-based).
 * Stops at the first page that reaches past `since` or comes back short.
 */
const readTransactionsSince = async (
  walletId: string,
  since: number,
): Promise<IbexAccountTransaction[] | Error> => {
  const seen = new Set<string>()
  const transactions: IbexAccountTransaction[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await Ibex.getAccountTransactions({
      account_id: walletId,
      limit: TRANSACTIONS_PAGE_SIZE,
      page,
      sort: "settledAt",
    })
    if (batch instanceof Error) return batch

    let oldest = Infinity
    for (const tx of batch as IbexAccountTransaction[]) {
      const createdAt = tx.createdAt ? new Date(tx.createdAt).getTime() : NaN
      if (!Number.isNaN(createdAt)) oldest = Math.min(oldest, createdAt)
      if (!tx.id || seen.has(tx.id)) continue
      seen.add(tx.id)
      transactions.push(tx)
    }

    if (batch.length < TRANSACTIONS_PAGE_SIZE || oldest < since) return transactions
  }

  logger.warn(
    { walletId, pages: MAX_PAGES },
    "split reconcile: page cap reached before the lookback; older receives not read",
  )
  return transactions
}

/**
 * Safety net for missed or failed webhooks: re-reads recent Lightning receives
 * on every wallet with enabled split rules and records any execution the
 * webhook did not. The trigger key is the payment hash — the same key the
 * webhook uses — so a receive the webhook already recorded is a duplicate-key
 * no-op.
 *
 * `cadenceMs` is how often the caller runs this. The lookback is derived from
 * it (splitReconcileWindowMs: cadence plus a margin) so consecutive runs always
 * overlap; a caller cannot hand in a window shorter than its own schedule.
 */
export const reconcileSplits = async ({
  cadenceMs,
  now = new Date(),
}: {
  cadenceMs: number
  now?: Date
}): Promise<ReconcileSplitsSummary | Error> => {
  const windowMs = splitReconcileWindowMs(cadenceMs)
  const summary: ReconcileSplitsSummary = {
    windowMs,
    wallets: 0,
    receivesSeen: 0,
    recorded: 0,
    errors: 0,
  }
  if (!PaymentSplitsConfig.enabled) return summary

  const walletIds = await PaymentSplitRulesRepository().listWalletIdsWithEnabledRules()
  if (walletIds instanceof Error) return walletIds

  const since = now.getTime() - windowMs

  for (const walletId of walletIds) {
    summary.wallets += 1

    const wallet = await WalletsRepository().findById(walletId as WalletId)
    if (wallet instanceof Error) {
      summary.errors += 1
      logger.warn({ walletId, error: wallet }, "split reconcile: wallet lookup failed")
      continue
    }

    const transactions = await readTransactionsSince(walletId, since)
    if (transactions instanceof Error) {
      summary.errors += 1
      logger.warn({ walletId, error: transactions }, "split reconcile: IBEX read failed")
      continue
    }

    for (const tx of transactions) {
      if (tx.transactionTypeId !== IBEX_LIGHTNING_RECEIVE) continue
      if (!tx.id || !tx.createdAt) continue
      const receivedAt = new Date(tx.createdAt)
      if (Number.isNaN(receivedAt.getTime()) || receivedAt.getTime() < since) continue

      summary.receivesSeen += 1

      // The list endpoint carries no payment hash; the details endpoint does.
      const details = await Ibex.getTransactionDetails(tx.id as IbexTransactionId)
      if (details instanceof Error) {
        summary.errors += 1
        logger.warn({ walletId, txId: tx.id, error: details }, "split reconcile: details")
        continue
      }
      const paymentHash = details.invoice?.hash
      if (typeof paymentHash !== "string" || !PaymentHashRegex.test(paymentHash)) continue

      const recorded = await recordSplitExecutions({
        walletId,
        triggerKey: paymentHash,
        paymentHash,
        amount: Number(details.amount ?? tx.amount ?? 0),
        currency: wallet.currency,
        receivedAt,
        now,
      })
      if (recorded instanceof Error) {
        summary.errors += 1
        logger.warn({ walletId, txId: tx.id, error: recorded }, "split reconcile: record")
        continue
      }
      summary.recorded += recorded.recorded
    }
  }

  return summary
}
