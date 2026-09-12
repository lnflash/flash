export * from "./errors"
export * from "./primitives"

/**
 * Order lifecycle. See the design doc §5.
 *
 *   CREATED → INVOICE_ISSUED → (PAYMENT_PENDING →) PAID → FULFILLED
 *
 * Terminal: FULFILLED, FAILED, PAYMENT_FAILED, EXPIRED, REFUND_REQUIRED.
 * REFUND_REQUIRED is the only state meaning "money left Flash and no card arrived".
 *
 * EXPIRED has one way out: EXPIRED → PAID. An INVOICE_ISSUED pay can still be
 * in flight at IBEX when `expiresAt` passes and the reconcile worker expires
 * the row; if that send then settles (a late Success on the purchase path, or
 * the vendor reporting the card shipped) the money has left and the order must
 * be able to say so. EXPIRED is still "terminal" for every listing purpose —
 * the worker never polls it and `hasOpenGiftCardOrders` does not count it —
 * because nothing the worker could do would revive it: only the purchase
 * path's late Success or a vendor poll from that path can.
 */
export const GiftCardOrderStatus = {
  Created: "CREATED",
  InvoiceIssued: "INVOICE_ISSUED",
  PaymentPending: "PAYMENT_PENDING",
  Paid: "PAID",
  Fulfilled: "FULFILLED",
  Failed: "FAILED",
  PaymentFailed: "PAYMENT_FAILED",
  Expired: "EXPIRED",
  RefundRequired: "REFUND_REQUIRED",
} as const

/**
 * "Nothing left for the worker to do." EXPIRED is included even though it has
 * a legal exit (→ PAID): that exit is only ever taken by the purchase path
 * (see the lifecycle doc above), never by the worker, so an EXPIRED order is
 * not open work.
 */
export const GIFT_CARD_TERMINAL_STATUSES: readonly GiftCardOrderStatus[] = [
  GiftCardOrderStatus.Fulfilled,
  GiftCardOrderStatus.Failed,
  GiftCardOrderStatus.PaymentFailed,
  GiftCardOrderStatus.Expired,
  GiftCardOrderStatus.RefundRequired,
]

/** Allowed transitions. Anything not listed is a `GiftCardOrderStateError`. */
export const GIFT_CARD_TRANSITIONS: Readonly<
  Record<GiftCardOrderStatus, readonly GiftCardOrderStatus[]>
> = {
  CREATED: ["INVOICE_ISSUED", "FAILED", "EXPIRED"],
  INVOICE_ISSUED: ["PAYMENT_PENDING", "PAID", "PAYMENT_FAILED", "EXPIRED", "FAILED"],
  PAYMENT_PENDING: ["PAID", "PAYMENT_FAILED"],
  PAID: ["FULFILLED", "REFUND_REQUIRED"],
  FULFILLED: [],
  FAILED: [],
  PAYMENT_FAILED: [],
  // A pay still in flight when the worker expired the row, then settled.
  EXPIRED: ["PAID"],
  REFUND_REQUIRED: [],
}

export const isGiftCardTerminalStatus = (status: GiftCardOrderStatus): boolean =>
  GIFT_CARD_TERMINAL_STATUSES.includes(status)

export const canTransitionGiftCardOrder = (
  from: GiftCardOrderStatus,
  to: GiftCardOrderStatus,
): boolean => GIFT_CARD_TRANSITIONS[from].includes(to)

/** Vendor invoice may exceed our quote by at most this much before we refuse to pay. */
export const GIFT_CARD_QUOTE_TOLERANCE_BPS = 100
