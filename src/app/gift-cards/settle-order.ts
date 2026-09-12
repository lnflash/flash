import { GiftCardOrderStateError, GiftCardOrderStatus } from "@domain/gift-cards"
import { encryptGiftCardClaim } from "@services/gift-cards/claim-crypto"
import { getRegisteredGiftCardProviderOrError } from "@services/gift-cards/registry"
import { baseLogger } from "@services/logger"
import { GiftCardOrdersRepository } from "@services/mongoose"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

import { notifyGiftCardOpsEvent } from "./ops"
import { sendGiftCardFulfilledNotificationBestEffort } from "./send-fulfilled-notification"

/**
 * THE settlement path. The purchase mutation's first poll, the reconcile
 * worker, and any future vendor webhook (Bitrefill) all hand a vendor status
 * to this one function, so "what does a vendor `refunded` mean for an order in
 * state X" has exactly one answer.
 *
 * Idempotent: settling an already-FULFILLED order with `fulfilled` returns it
 * unchanged and never re-encrypts or re-notifies. Races between two settlers
 * are decided by the repository's conditional transition — the loser gets a
 * `GiftCardOrderStateError`, re-reads, and returns whatever won.
 *
 * Claim data enters here as plaintext from the adapter and leaves only as
 * ciphertext on the order. It is never logged, traced, or put in an ops event.
 */
export const settleOrderFromVendor = async (
  order: GiftCardOrder,
  status: GiftCardProviderOrderStatus,
): Promise<GiftCardOrder | ApplicationError> => {
  addAttributesToCurrentSpan({
    "giftcard.orderId": order.id,
    "giftcard.provider": order.providerId,
    "giftcard.vendorStatus": status.kind,
    "giftcard.status": order.status,
  })

  switch (status.kind) {
    case "awaitingPayment":
    case "paidPendingFulfillment":
      return order
    case "fulfilled":
      return fulfil(order, status.claim)
    case "failed":
    case "refunded":
      return vendorFailed(order, status)
  }
}

const fulfil = async (
  order: GiftCardOrder,
  claim: GiftCardClaim,
): Promise<GiftCardOrder | ApplicationError> => {
  const repo = GiftCardOrdersRepository()

  if (order.status === GiftCardOrderStatus.Fulfilled) return order

  let current = order
  // The vendor saw our payment before we recorded it (a crash between the pay
  // call and the PAID transition, a Pending that settled, or a send still in
  // flight when the worker expired the row). Their word that the card shipped
  // is proof of payment; record it so the order can proceed.
  if (
    current.status === GiftCardOrderStatus.InvoiceIssued ||
    current.status === GiftCardOrderStatus.PaymentPending ||
    current.status === GiftCardOrderStatus.Expired
  ) {
    const paid = await repo.transition({
      id: current.id,
      from: [
        GiftCardOrderStatus.InvoiceIssued,
        GiftCardOrderStatus.PaymentPending,
        GiftCardOrderStatus.Expired,
      ],
      to: GiftCardOrderStatus.Paid,
      reason: "vendor-reported-fulfilled",
      patch: { paidSats: current.invoiceSats ?? current.quoteSats },
    })
    if (paid instanceof Error) return paid
    notifyGiftCardOpsEvent({ phase: "order-paid", status: "success", order: paid })
    current = paid
  }

  if (current.status !== GiftCardOrderStatus.Paid) {
    // FAILED / PAYMENT_FAILED / REFUND_REQUIRED, yet the vendor says a card
    // was issued. Someone paid for it; our records say not us. Page.
    const error = new GiftCardOrderStateError(
      `Vendor reports fulfilled but order is ${current.status}`,
    )
    recordExceptionInCurrentSpan({ error })
    notifyGiftCardOpsEvent({
      phase: "vendor-fulfilled-unexpected",
      status: "failed",
      order: current,
      error: error.constructor.name,
      meta: { orderStatus: current.status },
    })
    return error
  }

  // Sealed to THIS order: the ciphertext will not open on any other row.
  const encrypted = encryptGiftCardClaim(claim, { orderId: current.id })
  if (encrypted instanceof Error) {
    // The card exists at the vendor; only our storage failed. Leave PAID so the
    // next poll retries once the key is fixed, and page because until then the
    // customer has paid for something they cannot see.
    recordExceptionInCurrentSpan({ error: encrypted })
    notifyGiftCardOpsEvent({
      phase: "claim-encrypt-failed",
      status: "failed",
      order: current,
      error: encrypted.constructor.name,
    })
    return encrypted
  }

  const fulfilled = await repo.transition({
    id: current.id,
    from: [GiftCardOrderStatus.Paid],
    to: GiftCardOrderStatus.Fulfilled,
    reason: "vendor-fulfilled",
    patch: {
      claimCiphertext: encrypted.ciphertext,
      claimKeyId: encrypted.keyId,
      fulfilledAt: new Date(),
    },
  })
  if (fulfilled instanceof GiftCardOrderStateError) {
    // Lost a race with another settler. Whatever it wrote is the truth.
    const latest = await repo.findById(current.id)
    if (!(latest instanceof Error) && latest.status === GiftCardOrderStatus.Fulfilled) {
      return latest
    }
    return fulfilled
  }
  if (fulfilled instanceof Error) return fulfilled

  notifyGiftCardOpsEvent({
    phase: "order-fulfilled",
    status: "success",
    order: fulfilled,
  })
  await sendGiftCardFulfilledNotificationBestEffort({
    accountId: fulfilled.accountId,
    orderId: fulfilled.id,
    brand: fulfilled.productSnapshot.brand,
    valueMinor: fulfilled.valueMinor,
    quantity: fulfilled.quantity,
    currency: fulfilled.currency,
  })
  return fulfilled
}

const vendorFailed = async (
  order: GiftCardOrder,
  status: Extract<GiftCardProviderOrderStatus, { kind: "failed" | "refunded" }>,
): Promise<GiftCardOrder | ApplicationError> => {
  const repo = GiftCardOrdersRepository()
  const reason = `vendor-${status.kind}: ${status.reason}`.slice(0, 500)

  switch (order.status) {
    case GiftCardOrderStatus.Paid: {
      // Money left Flash; no card is coming. The ONLY state that means that,
      // and the one this flow pages on.
      const refund = await repo.transition({
        id: order.id,
        from: [GiftCardOrderStatus.Paid],
        to: GiftCardOrderStatus.RefundRequired,
        reason,
        patch: { failureReason: reason },
      })
      if (refund instanceof Error) return refund
      notifyGiftCardOpsEvent({
        phase: "refund-required",
        status: "failed",
        order: refund,
        error: `vendor-${status.kind}`,
        meta: { reason: status.reason.slice(0, 80) },
      })
      return refund
    }
    case GiftCardOrderStatus.Created:
    case GiftCardOrderStatus.InvoiceIssued: {
      // Vendor cancelled before we paid. Nothing moved.
      const failed = await repo.transition({
        id: order.id,
        from: [GiftCardOrderStatus.Created, GiftCardOrderStatus.InvoiceIssued],
        to: GiftCardOrderStatus.Failed,
        reason,
        patch: { failureReason: reason },
      })
      if (failed instanceof Error) return failed
      notifyGiftCardOpsEvent({
        phase: "order-failed",
        status: "failed",
        order: failed,
        error: `vendor-${status.kind}`,
        meta: { reason: status.reason.slice(0, 80) },
      })
      return failed
    }
    case GiftCardOrderStatus.PaymentPending:
      // Our payment may still be in flight. Whether it settled decides
      // PAID→REFUND_REQUIRED or PAYMENT_FAILED; that is the reconcile worker's
      // payment re-read, not the vendor's word.
      baseLogger.warn(
        { orderId: order.id, vendorStatus: status.kind },
        "Vendor reports failed/refunded while our payment is pending; leaving for payment re-read",
      )
      return order
    default:
      return order
  }
}

export type FetchVendorOrderOptions = {
  /**
   * Passed through to the adapter. The purchase mutation's inline first poll
   * sets `retry: false`: the customer is waiting on the response, and the
   * reconcile worker will ask again in seconds anyway. The worker leaves the
   * adapter's default.
   */
  retry?: boolean
}

/**
 * Ask the vendor where the order stands, without acting on the answer.
 *
 * Resolves the order's provider by registration, not by `enabled`: the kill
 * switch (`giftCards.enabled`, `providers.<id>.enabled`) stops NEW money
 * leaving via quote/purchase. An order that already exists has already paid or
 * may have, and refusing to look it up would strand the customer's code.
 */
export const fetchVendorOrderStatus = async (
  order: GiftCardOrder,
  opts?: FetchVendorOrderOptions,
): Promise<GiftCardProviderOrderStatus | ApplicationError> => {
  const provider = getRegisteredGiftCardProviderOrError(order.providerId)
  if (provider instanceof Error) return provider

  if (!order.providerOrderId) {
    return new GiftCardOrderStateError("Order has no provider order id to look up")
  }

  return provider.getOrder(
    {
      providerOrderId: order.providerOrderId,
      paymentRequest: order.paymentRequest,
    },
    opts,
  )
}

/**
 * Ask the vendor where the order stands and settle on the answer. The
 * reconcile worker's PAID path and the purchase mutation's single
 * fulfilled-already? poll. (The worker's fallback for payments IBEX cannot
 * account for uses the two halves separately: it needs the vendor's answer
 * itself, not just what it did to the order.)
 */
export const fetchAndSettle = async (
  order: GiftCardOrder,
  opts?: FetchVendorOrderOptions,
): Promise<GiftCardOrder | ApplicationError> => {
  const status = await fetchVendorOrderStatus(order, opts)
  if (status instanceof Error) return status

  return settleOrderFromVendor(order, status)
}
