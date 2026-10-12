import { PaymentSplitsConfig } from "@config"

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

// Transactions read per wallet per run. The window is short, so a page this
// size covers any plausible receive rate.
const TRANSACTIONS_PAGE_SIZE = 100

const PaymentHashRegex = /^[0-9a-f]{64}$/i

export type ReconcileSplitsSummary = {
  wallets: number
  receivesSeen: number
  recorded: number
  errors: number
}

/**
 * Safety net for missed or failed webhooks: re-reads recent Lightning receives
 * on every wallet with enabled split rules and records any execution the
 * webhook did not. The trigger key is the payment hash — the same key the
 * webhook uses — so a receive the webhook already recorded is a duplicate-key
 * no-op.
 */
export const reconcileSplits = async ({
  windowMs,
  now = new Date(),
}: {
  windowMs: number
  now?: Date
}): Promise<ReconcileSplitsSummary | Error> => {
  const summary: ReconcileSplitsSummary = {
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

    const transactions = await Ibex.getAccountTransactions({
      account_id: walletId,
      limit: TRANSACTIONS_PAGE_SIZE,
    })
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
