import { randomUUID } from "crypto"

import { GiftCardsConfig } from "@config"

import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { GiftCardOrderStatus, UnknownGiftCardError } from "@domain/gift-cards"
import Ibex from "@services/ibex/client"
import { UnconfirmedIbexPayment } from "@services/ibex/errors"
import { paymentSendStatusFromIbex } from "@services/ibex/payment-status"
import { baseLogger } from "@services/logger"
import { GiftCardOrdersRepository } from "@services/mongoose"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

import { notifyGiftCardOpsEvent } from "./ops"
import { fetchAndSettle } from "./settle-order"

// Lazy, for the same reason as reservation-store.ts: no live Redis client as
// an import-time side effect of anything that pulls in the app barrel.
const redisClient = async () => (await import("@services/redis")).redis

const logger = baseLogger.child({ module: "gift-cards.reconcile" })

/**
 * ENG-581 — the fulfilment worker.
 *
 * Everything the purchase mutation does not wait for ends up here:
 *
 *   CREATED / INVOICE_ISSUED past `expiresAt`  → EXPIRED (after one payment re-read)
 *   PAYMENT_PENDING                           → PAID | PAYMENT_FAILED (payment re-read)
 *   PAID                                      → poll vendor with backoff → FULFILLED
 *                                               | REFUND_REQUIRED; 24h → REFUND_REQUIRED
 *
 * Runs under a Redis lock so the cron pod and the trigger's 30s interval never
 * work the same batch at once. Never throws: a per-order failure is logged,
 * counted, and the loop moves on — one vendor 500 must not strand the other
 * orders in the batch.
 *
 * Backoff per PAID order: 5s, 15s, 60s, 5m, then every 15m, measured from the
 * PAID transition. Attempts are tracked in process memory (nothing on the
 * order changes on a poll, by design — `transition` is the only write), which
 * gives the trigger's interval its real schedule and costs the cron exactly one
 * attempt per run, which is what a 15-minute cadence would do anyway.
 */
export type GiftCardReconcileSummary = {
  scanned: number
  fulfilled: number
  refundRequired: number
  expired: number
  paymentSettled: number
  /** Set when another worker held the lock and this run did nothing. */
  skipped?: "lock-held"
}

export const GIFT_CARD_RECONCILE_LOCK_KEY = "giftcards:reconcile:lock"
const LOCK_TTL_MS = 5 * 60 * 1000
const BATCH_LIMIT = 200

const SECOND = 1000
const MINUTE = 60 * SECOND
export const GIFT_CARD_PAID_TIMEOUT_MS = 24 * 60 * MINUTE
// Pending payments have their own horizon: IBEX reports in-flight sends for a
// bounded time, and an order our own rail cannot tell us about after this long
// needs a human, not another poll.
const PAYMENT_PENDING_WARN_MS = 60 * MINUTE

/**
 * Gap to the next poll given how long the order had been PAID at the last
 * attempt. The schedule the ticket names, as a step function: 5s, 15s, 60s,
 * 5m, then every 15m.
 */
export const giftCardPollGapMs = (elapsedSincePaidMs: number): number => {
  if (elapsedSincePaidMs < 5 * SECOND) return 5 * SECOND
  if (elapsedSincePaidMs < 20 * SECOND) return 15 * SECOND
  if (elapsedSincePaidMs < 80 * SECOND) return 60 * SECOND
  if (elapsedSincePaidMs < 380 * SECOND) return 5 * MINUTE
  return 15 * MINUTE
}

/** When the next vendor poll is due. `lastAttemptAtMs` defaults to the PAID transition. */
export const nextGiftCardPollAt = (
  paidAtMs: number,
  lastAttemptAtMs?: number,
): number => {
  const last = Math.max(paidAtMs, lastAttemptAtMs ?? paidAtMs)
  return last + giftCardPollGapMs(last - paidAtMs)
}

const lastAttemptAt = new Map<string, number>()

export const __resetGiftCardReconcileStateForTest = (): void => {
  lastAttemptAt.clear()
}

const lastTransitionAt = (order: GiftCardOrder, status: GiftCardOrderStatus): Date => {
  for (let i = order.statusHistory.length - 1; i >= 0; i -= 1) {
    if (order.statusHistory[i].status === status) return order.statusHistory[i].at
  }
  return order.updatedAt
}

type SentPaymentStatus = "settled" | "failed" | "pending" | "unknown"

/**
 * Re-read a sent payment from IBEX.
 *
 * `payLnInvoiceViaIbex` exposes the pay 200's `transaction.id`, which
 * `purchaseGiftCard` stores as `providerPaymentRef`. `getTransactionDetails`
 * on that id returns the same payment-level fields the pay response carries
 * (`payment.statusId`, `payment.status.id`, `payment.failureId`), so the one
 * reader, `paymentSendStatusFromIbex`, maps both.
 *
 * No ref → "unknown". That is an order that crashed between the IBEX call and
 * the transition that would have written the ref, or a 200 whose
 * `transaction.id` was empty. THERE IS NO HASH-BASED FALLBACK: the
 * `getAccountTransactions` (IBEX `G`) 200 items carry only id / createdAt /
 * accountId / amount / networkFee / exchangeRateCurrencySats / currencyId /
 * transactionTypeId — no `payment.hash` and no `bolt11` — and `invoiceFromHash`
 * resolves only invoices WE issued. Such an order stays PAYMENT_PENDING and is
 * warned on after PAYMENT_PENDING_WARN_MS; resolving it needs the IBEX
 * dashboard. (The LND-rail `lnpayments` collection is not consulted: nothing
 * writes it on this IBEX-custodial deployment.)
 *
 * An IbexError (network, 5xx, 404) is "unknown" too: it says nothing about
 * whether money moved, and the next run retries. An UnconfirmedIbexPayment —
 * the transaction exists but reports no recognised payment status — is also
 * "unknown" rather than "pending", so it cannot hold an expired invoice open
 * indefinitely on a claim IBEX never actually made.
 */
const lookupSentPaymentStatus = async (
  order: GiftCardOrder,
): Promise<SentPaymentStatus> => {
  if (!order.providerPaymentRef) return "unknown"

  const details = await Ibex.getTransactionDetails(
    order.providerPaymentRef as IbexTransactionId,
  )
  if (details instanceof Error) {
    logger.warn(
      {
        orderId: order.id,
        providerPaymentRef: order.providerPaymentRef,
        error: details.constructor.name,
      },
      "Could not re-read gift card payment from IBEX",
    )
    return "unknown"
  }

  const status = paymentSendStatusFromIbex({
    transaction: { id: details.id, payment: details.payment },
  })
  if (status instanceof UnconfirmedIbexPayment) return "unknown"

  switch (status.value) {
    case PaymentSendStatus.Success.value:
    case PaymentSendStatus.AlreadyPaid.value:
      return "settled"
    case PaymentSendStatus.Failure.value:
      return "failed"
    default:
      return "pending"
  }
}

const acquireLock = async (): Promise<string | null> => {
  const redis = await redisClient()
  const token = randomUUID()
  const res = await redis.set(
    GIFT_CARD_RECONCILE_LOCK_KEY,
    token,
    "PX",
    LOCK_TTL_MS,
    "NX",
  )
  return res === "OK" ? token : null
}

// Compare-and-delete so a run that outlived its TTL cannot drop a lock another
// worker has since taken.
const releaseLock = async (token: string): Promise<void> => {
  try {
    const redis = await redisClient()
    const current = await redis.get(GIFT_CARD_RECONCILE_LOCK_KEY)
    if (current === token) await redis.del(GIFT_CARD_RECONCILE_LOCK_KEY)
  } catch (error) {
    logger.warn(
      { error },
      "Could not release gift card reconcile lock; it will lapse at TTL",
    )
  }
}

const settleAsPaid = async (
  order: GiftCardOrder,
  summary: GiftCardReconcileSummary,
  reason: string,
): Promise<void> => {
  const repo = GiftCardOrdersRepository()
  const paid = await repo.transition({
    id: order.id,
    from: [GiftCardOrderStatus.InvoiceIssued, GiftCardOrderStatus.PaymentPending],
    to: GiftCardOrderStatus.Paid,
    reason,
    patch: { paidSats: order.invoiceSats ?? order.quoteSats },
  })
  if (paid instanceof Error) throw paid
  summary.paymentSettled += 1
  notifyGiftCardOpsEvent({ phase: "order-paid", status: "success", order: paid })

  lastAttemptAt.set(paid.id, Date.now())
  const settled = await fetchAndSettle(paid)
  if (settled instanceof Error) {
    logger.info(
      { orderId: paid.id, error: settled.constructor.name },
      "Settled payment; vendor poll did not fulfil yet",
    )
    return
  }
  if (settled.status === GiftCardOrderStatus.Fulfilled) {
    summary.fulfilled += 1
    lastAttemptAt.delete(paid.id)
  }
  if (settled.status === GiftCardOrderStatus.RefundRequired) summary.refundRequired += 1
}

const processExpiry = async (
  order: GiftCardOrder,
  now: Date,
  summary: GiftCardReconcileSummary,
): Promise<void> => {
  if (order.expiresAt.getTime() >= now.getTime()) return

  // An INVOICE_ISSUED order may have been paid by a call that crashed before
  // recording it. One re-read before writing it off: settled → PAID, in
  // flight → leave it for the PAYMENT_PENDING path next run. Only possible
  // when the IBEX transaction id was persisted; a crash BETWEEN the IBEX call
  // and the transition that writes it leaves no ref, the lookup answers
  // "unknown", and the order is expired — the one window where a paid invoice
  // can be written off, logged here so it is at least visible.
  if (order.status === GiftCardOrderStatus.InvoiceIssued) {
    const payment = await lookupSentPaymentStatus(order)
    if (payment === "settled") {
      await settleAsPaid(order, summary, "payment-settled-on-reconcile")
      return
    }
    if (payment === "pending") {
      logger.warn(
        { orderId: order.id },
        "Expired gift card invoice still has an in-flight payment; not expiring",
      )
      return
    }
  }

  const expired = await GiftCardOrdersRepository().transition({
    id: order.id,
    from: [GiftCardOrderStatus.Created, GiftCardOrderStatus.InvoiceIssued],
    to: GiftCardOrderStatus.Expired,
    reason: "expired",
    patch: { failureReason: "expired" },
  })
  if (expired instanceof Error) throw expired
  summary.expired += 1
  notifyGiftCardOpsEvent({
    phase: "order-failed",
    status: "failed",
    order: expired,
    meta: { reason: "expired" },
  })
}

const processPendingPayment = async (
  order: GiftCardOrder,
  now: Date,
  summary: GiftCardReconcileSummary,
): Promise<void> => {
  const payment = await lookupSentPaymentStatus(order)
  switch (payment) {
    case "settled":
      await settleAsPaid(order, summary, "payment-settled-on-reconcile")
      return
    case "failed": {
      const failed = await GiftCardOrdersRepository().transition({
        id: order.id,
        from: [GiftCardOrderStatus.PaymentPending],
        to: GiftCardOrderStatus.PaymentFailed,
        reason: "payment-failed-on-reconcile",
        patch: { failureReason: "payment-failed" },
      })
      if (failed instanceof Error) throw failed
      notifyGiftCardOpsEvent({
        phase: "order-failed",
        status: "failed",
        order: failed,
        meta: { reason: "payment-failed" },
      })
      return
    }
    default: {
      const pendingSince = lastTransitionAt(order, GiftCardOrderStatus.PaymentPending)
      if (now.getTime() - pendingSince.getTime() > PAYMENT_PENDING_WARN_MS) {
        logger.warn(
          {
            orderId: order.id,
            paymentHash: order.paymentHash,
            providerPaymentRef: order.providerPaymentRef,
            since: pendingSince,
          },
          "Gift card payment has been pending for over an hour with no resolvable status",
        )
      }
    }
  }
}

const processPaid = async (
  order: GiftCardOrder,
  now: Date,
  summary: GiftCardReconcileSummary,
): Promise<void> => {
  const paidAtMs = lastTransitionAt(order, GiftCardOrderStatus.Paid).getTime()
  const nowMs = now.getTime()

  if (nowMs - paidAtMs >= GIFT_CARD_PAID_TIMEOUT_MS) {
    const refund = await GiftCardOrdersRepository().transition({
      id: order.id,
      from: [GiftCardOrderStatus.Paid],
      to: GiftCardOrderStatus.RefundRequired,
      reason: "fulfillment-timeout",
      patch: { failureReason: "fulfillment-timeout" },
    })
    if (refund instanceof Error) throw refund
    lastAttemptAt.delete(order.id)
    summary.refundRequired += 1
    notifyGiftCardOpsEvent({
      phase: "refund-required",
      status: "failed",
      order: refund,
      error: "fulfillment-timeout",
      meta: { reason: "fulfillment-timeout" },
    })
    return
  }

  if (nowMs < nextGiftCardPollAt(paidAtMs, lastAttemptAt.get(order.id))) return
  lastAttemptAt.set(order.id, nowMs)

  const settled = await fetchAndSettle(order)
  if (settled instanceof Error) throw settled
  if (settled.status === GiftCardOrderStatus.Fulfilled) {
    summary.fulfilled += 1
    lastAttemptAt.delete(order.id)
  } else if (settled.status === GiftCardOrderStatus.RefundRequired) {
    summary.refundRequired += 1
    lastAttemptAt.delete(order.id)
  }
}

const forEachOrder = async (
  orders: GiftCardOrder[],
  summary: GiftCardReconcileSummary,
  fn: (order: GiftCardOrder) => Promise<void>,
): Promise<void> => {
  for (const order of orders) {
    summary.scanned += 1
    try {
      await fn(order)
    } catch (error) {
      // One order's vendor/repo failure never stops the batch.
      recordExceptionInCurrentSpan({ error })
      logger.error(
        { orderId: order.id, status: order.status, error },
        "Gift card reconcile failed for order",
      )
    }
  }
}

export const reconcileGiftCardOrders = async (
  now: Date = new Date(),
): Promise<GiftCardReconcileSummary | ApplicationError> => {
  const summary: GiftCardReconcileSummary = {
    scanned: 0,
    fulfilled: 0,
    refundRequired: 0,
    expired: 0,
    paymentSettled: 0,
  }

  let token: string | null
  try {
    token = await acquireLock()
  } catch (error) {
    return new UnknownGiftCardError(
      `Could not acquire gift card reconcile lock: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (token === null) {
    addAttributesToCurrentSpan({ "giftcard.reconcile.skipped": "lock-held" })
    return { ...summary, skipped: "lock-held" }
  }

  try {
    const repo = GiftCardOrdersRepository()

    const open = await repo.listByStatus({
      statuses: [GiftCardOrderStatus.Created, GiftCardOrderStatus.InvoiceIssued],
      limit: BATCH_LIMIT,
    })
    if (open instanceof Error) {
      logger.error({ error: open }, "Could not list open gift card orders")
    } else {
      await forEachOrder(
        open.filter((o) => o.expiresAt.getTime() < now.getTime()),
        summary,
        (order) => processExpiry(order, now, summary),
      )
    }

    const pending = await repo.listByStatus({
      statuses: [GiftCardOrderStatus.PaymentPending],
      limit: BATCH_LIMIT,
    })
    if (pending instanceof Error) {
      logger.error({ error: pending }, "Could not list payment-pending gift card orders")
    } else {
      await forEachOrder(pending, summary, (order) =>
        processPendingPayment(order, now, summary),
      )
    }

    const paid = await repo.listByStatus({
      statuses: [GiftCardOrderStatus.Paid],
      limit: BATCH_LIMIT,
    })
    if (paid instanceof Error) {
      logger.error({ error: paid }, "Could not list paid gift card orders")
    } else {
      await forEachOrder(paid, summary, (order) => processPaid(order, now, summary))
    }

    addAttributesToCurrentSpan({
      "giftcard.reconcile.scanned": summary.scanned,
      "giftcard.reconcile.fulfilled": summary.fulfilled,
      "giftcard.reconcile.refundRequired": summary.refundRequired,
      "giftcard.reconcile.expired": summary.expired,
      "giftcard.reconcile.paymentSettled": summary.paymentSettled,
    })
    return summary
  } finally {
    await releaseLock(token)
  }
}

/**
 * Cron entry (src/servers/cron.ts). Self-guards on the master switch; a
 * returned error is thrown so the cron runner logs and counts the failure the
 * way it does every other task.
 */
export const reconcileGiftCardOrdersJob = async (): Promise<void> => {
  if (!GiftCardsConfig?.enabled) return
  const summary = await reconcileGiftCardOrders()
  if (summary instanceof Error) throw summary
  logger.info({ summary }, "gift card reconcile finished")
}

export const GIFT_CARD_RECONCILE_INTERVAL_MS = 30 * SECOND

/**
 * In-process schedule for the trigger server, so a PAID order reaches
 * FULFILLED in seconds rather than at the next 15-minute cron. Overlapping
 * ticks are skipped locally; cross-pod overlap is the Redis lock's job.
 */
export const startGiftCardReconcileInterval = (
  intervalMs: number = GIFT_CARD_RECONCILE_INTERVAL_MS,
): NodeJS.Timeout | null => {
  if (!GiftCardsConfig?.enabled) return null
  let running = false
  return setInterval(async () => {
    if (running) return
    running = true
    try {
      const summary = await reconcileGiftCardOrders()
      if (summary instanceof Error) {
        logger.warn({ error: summary }, "gift card reconcile tick failed")
      }
    } catch (error) {
      logger.error({ error }, "gift card reconcile tick threw")
    } finally {
      running = false
    }
  }, intervalMs)
}
