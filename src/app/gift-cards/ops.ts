import { notifyOpsEvent, OpsStatus } from "@services/alerts/ops-events"
import { buildGiftCardProductId } from "@domain/gift-cards"

/**
 * One shape for every `giftcard` ops event, so the Discord funnel reads the
 * same fields top to bottom: amount in display units, `orderId`, `providerId`,
 * `productId`, plus whatever the phase adds.
 *
 * NEVER pass claim data through here. The helper takes an order, not a claim,
 * precisely so the call sites have nothing bearer-shaped in scope to leak.
 */
export type GiftCardOpsPhase =
  | "order-created"
  | "order-paid"
  | "payment-pending"
  | "order-fulfilled"
  | "order-failed"
  | "refund-required"
  | "claim-encrypt-failed"
  | "vendor-fulfilled-unexpected"

export const notifyGiftCardOpsEvent = ({
  phase,
  status,
  order,
  error,
  meta,
}: {
  phase: GiftCardOpsPhase
  status: OpsStatus
  order: Pick<
    GiftCardOrder,
    | "id"
    | "accountId"
    | "providerId"
    | "providerProductId"
    | "valueMinor"
    | "quantity"
    | "currency"
  >
  error?: string
  meta?: Record<string, string>
}): void => {
  notifyOpsEvent({
    flow: "giftcard",
    phase,
    status,
    accountId: order.accountId,
    amount: {
      value: ((order.valueMinor * order.quantity) / 100).toFixed(2),
      currency: order.currency,
    },
    error,
    meta: {
      orderId: order.id,
      providerId: order.providerId,
      productId: buildGiftCardProductId(order.providerId, order.providerProductId),
      ...meta,
    },
  })
}
