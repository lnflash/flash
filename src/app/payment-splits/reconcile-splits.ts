import { PaymentSplitsConfig } from "@config"

import { splitReconcileWindowMs } from "@domain/payment-splits"

import Ibex from "@services/ibex/client"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { baseLogger } from "@services/logger"
import { parseRepositoryError } from "@services/mongoose/utils"
import { PaymentSplitExecution } from "@services/mongoose/schema"
import { SplitReceiveAccountsRepository } from "@services/mongoose/split-receive-accounts"
import { WalletsRepository } from "@services/mongoose"

import { buildLegs } from "./build-legs"

const logger = baseLogger.child({ module: "payment-splits-reconcile" })

// IBEX transaction type ids (GET /v2/transaction-types/all).
const IBEX_LIGHTNING_RECEIVE = 1
// Type 9 (crypto receive: USDT on Ethereum) deliberately does NOT trigger
// splits (v1 decision kept): Bridge virtual-account deposits arrive as the
// same type on the same address, so a split could not tell them apart.

// Transactions read per IBEX page. Pages are read newest-settled first until
// one reaches past the lookback, so a busy shadow is covered whatever its
// receive rate; MAX_PAGES only stops a runaway loop (50k transactions).
const TRANSACTIONS_PAGE_SIZE = 100
const MAX_PAGES = 500

const PaymentHashRegex = /^[0-9a-f]{64}$/i

export type ReconcileSplitsSummary = {
  windowMs: number
  shadows: number
  receivesSeen: number
  recorded: number
  residueAlerts: number
  errors: number
}

type IbexAccountTransaction = {
  id?: string
  createdAt?: string
  amount?: number
  transactionTypeId?: number
}

/**
 * Every transaction on `accountId` from the newest back to `since`, one IBEX
 * page at a time (sort settledAt: newest settled first; pages are 0-based).
 * Stops at the first page that reaches past `since` or comes back short.
 */
const readTransactionsSince = async (
  accountId: string,
  since: number,
): Promise<IbexAccountTransaction[] | Error> => {
  const seen = new Set<string>()
  const transactions: IbexAccountTransaction[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await Ibex.getAccountTransactions({
      account_id: accountId,
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
    { accountId, pages: MAX_PAGES },
    "split reconcile: page cap reached before the lookback; older receives not read",
  )
  return transactions
}

/**
 * Safety net for missed or failed webhooks, scoped to shadows only (ENG-717
 * decision 5: the v1 IBEX-wide scan is gone): re-reads recent Lightning
 * receives on every SplitReceiveAccount and builds the leg set any receive
 * the webhook did not. The trigger key is the payment hash — the same key the
 * webhook uses — so a receive the webhook already built is a duplicate-key
 * no-op.
 *
 * Second job: residue alert. A shadow holding a balance with no
 * pending/sending legs for longer than paymentSplits.shadowAlertAfterMs means
 * something did not fan out (a stuck net leg, an unknown leg, a missed
 * webhook on a wallet whose rules were deleted). Funds in a Flash-owned
 * account are customer money in custody — alert ops; draining residue to the
 * merchant is a manual step off this alert, not an automated payout.
 *
 * `cadenceMs` is how often the caller runs this. The lookback is derived from
 * it (splitReconcileWindowMs: cadence plus a margin) so consecutive runs
 * always overlap.
 *
 * IBEX's balance read lags a just-settled pay by ≥1 s (Phase 0), and the
 * alert window (default 10 min) is orders of magnitude wider — a lagging
 * balance read cannot trip it.
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
    shadows: 0,
    receivesSeen: 0,
    recorded: 0,
    residueAlerts: 0,
    errors: 0,
  }
  if (!PaymentSplitsConfig.enabled) return summary

  const shadows = await SplitReceiveAccountsRepository().listAll()
  if (shadows instanceof Error) return shadows

  const since = now.getTime() - windowMs

  for (const shadow of shadows) {
    summary.shadows += 1

    const wallet = await WalletsRepository().findById(shadow.walletId as WalletId)
    if (wallet instanceof Error) {
      summary.errors += 1
      logger.warn(
        { walletId: shadow.walletId, error: wallet },
        "split reconcile: wallet lookup failed",
      )
      continue
    }

    const transactions = await readTransactionsSince(shadow.ibexAccountId, since)
    if (transactions instanceof Error) {
      summary.errors += 1
      logger.warn(
        { shadowId: shadow.ibexAccountId, error: transactions },
        "split reconcile: IBEX read failed",
      )
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
        logger.warn(
          { shadowId: shadow.ibexAccountId, txId: tx.id, error: details },
          "split reconcile: details",
        )
        continue
      }
      const paymentHash = details.invoice?.hash
      if (typeof paymentHash !== "string" || !PaymentHashRegex.test(paymentHash)) continue

      const built = await buildLegs({
        walletId: shadow.walletId,
        sourceIbexAccountId: shadow.ibexAccountId,
        triggerKey: paymentHash,
        paymentHash,
        grossAmount: Number(details.amount ?? tx.amount ?? 0),
        currency: shadow.currency,
        receivedAt,
        now,
      })
      if (built instanceof Error) {
        summary.errors += 1
        logger.warn(
          { shadowId: shadow.ibexAccountId, txId: tx.id, error: built },
          "split reconcile: build legs",
        )
        continue
      }
      summary.recorded += built.recorded
    }

    // Residue check: legs still open for this trigger, against the shadow's
    // current balance. A zero balance needs no alert regardless of legs; a
    // balance with an open leg inside the alert window is mid-fanout (or a
    // lagging read) and waits; a balance with no open legs at all, or open
    // legs older than the window, alerts.
    const details = await Ibex.getAccountDetails(shadow.ibexAccountId as IbexAccountId)
    if (details instanceof Error) {
      summary.errors += 1
      logger.warn(
        { shadowId: shadow.ibexAccountId, error: details },
        "split reconcile: shadow balance read failed",
      )
      continue
    }
    // asPaymentAmount is the one reader both USD (cents) and USDT (micros)
    // amount classes share — it returns major units (dollars / USDT).
    const balanceMajor = details.balance
      ? Number(details.balance.asPaymentAmount().amount)
      : 0
    const balanceCents = Math.round(balanceMajor * 100)
    if (balanceCents <= 0) continue

    const openLegs = await hasOpenLegsForShadow(shadow.ibexAccountId)
    if (openLegs instanceof Error) {
      summary.errors += 1
      continue
    }
    if (openLegs.open && openLegs.oldestUpdatedAt) {
      const openMs = now.getTime() - openLegs.oldestUpdatedAt.getTime()
      if (openMs < PaymentSplitsConfig.shadowAlertAfterMs) continue
    }

    summary.residueAlerts += 1
    logger.error(
      {
        walletId: shadow.walletId,
        shadowId: shadow.ibexAccountId,
        balanceCents,
        openLegs,
      },
      "split reconcile: shadow receive account holds a residual balance; customer funds in custody — resolve by hand",
    )
    notifyOpsEvent({
      flow: "deposit",
      phase: "split-residue",
      status: "failed",
      amount: { value: (balanceCents / 100).toFixed(2), currency: "USD" },
      meta: {
        walletId: shadow.walletId,
        shadowId: shadow.ibexAccountId,
        reason: "residual-balance-on-shadow",
      },
    })
  }

  return summary
}

// Whether the shadow has any leg row not yet terminal, and how old the oldest
// open one is. Repo-level query kept local: it is reconcile-only.
const hasOpenLegsForShadow = async (
  sourceIbexAccountId: string,
): Promise<{ open: boolean; oldestUpdatedAt?: Date } | RepositoryError> => {
  try {
    const doc = await PaymentSplitExecution.findOne({
      sourceIbexAccountId: { $eq: sourceIbexAccountId },
      status: { $in: ["pending", "sending"] },
    })
      .sort({ updatedAt: 1 })
      .lean<{ updatedAt: Date } | null>()
      .exec()
    if (!doc) return { open: false }
    return { open: true, oldestUpdatedAt: new Date(doc.updatedAt) }
  } catch (error) {
    return parseRepositoryError(error)
  }
}
