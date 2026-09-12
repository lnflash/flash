// Catalog (ENG-579)
export * from "./sync-catalog"
export * from "./list-products"

// Gate, limits, purchase, settlement, worker, reads (ENG-580 / 581 / 583).
//
// Named exports only: `src/app/index.ts` wraps EVERY key of this namespace in
// a tracing span as if it were a function, so a const object exported here
// would come out the other side as a callable and silently stop being an
// object. Consts (`GiftCardRejectionReasons`, the reconcile schedule helpers)
// stay importable from their own modules.
export {
  giftCardsMasterGate,
  resolveAccountCountryCode,
  resolveAccountCountryCodeOrUnknown,
} from "./gift-cards-master-gate"
export type { GiftCardsMasterGate } from "./gift-cards-master-gate"
export {
  authorizeGiftCardPurchase,
  releaseGiftCardReservation,
} from "./authorize-purchase"
export type {
  GiftCardAuthorization,
  GiftCardRejectionReason,
  AuthorizeGiftCardPurchaseArgs,
} from "./authorize-purchase"
export { purchaseGiftCard } from "./purchase-gift-card"
export type { PurchaseGiftCardArgs } from "./purchase-gift-card"
export { quoteGiftCard } from "./quote-gift-card"
export type { QuoteGiftCardArgs } from "./quote-gift-card"
export { settleOrderFromVendor, fetchAndSettle } from "./settle-order"
export {
  reconcileGiftCardOrders,
  reconcileGiftCardOrdersJob,
  startGiftCardReconcileInterval,
} from "./reconcile-orders"
export type { GiftCardReconcileSummary } from "./reconcile-orders"
export { getGiftCardOrderForAccount } from "./get-order"
export type { GiftCardOrderWithClaim } from "./get-order"
export { listGiftCardOrdersForAccount } from "./list-orders"
export type { GiftCardOrderPage } from "./list-orders"
export { sendGiftCardFulfilledNotificationBestEffort } from "./send-fulfilled-notification"
