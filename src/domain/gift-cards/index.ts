export * from "./errors"
export * from "./primitives"

/**
 * Order lifecycle. See the design doc §5.
 *
 *   CREATED → INVOICE_ISSUED → (PAYMENT_PENDING →) PAID → FULFILLED
 *
 * Terminal: FULFILLED, FAILED, PAYMENT_FAILED, EXPIRED, REFUND_REQUIRED.
 * REFUND_REQUIRED is the only state meaning "money left Flash and no card arrived".
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
  EXPIRED: [],
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
