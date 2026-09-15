import { RepositoryError } from "@domain/errors"
import {
  GIFT_CARD_TRANSITIONS,
  GiftCardOrderStateError,
  canTransitionGiftCardOrder,
  toGiftCardOrderId,
  toGiftCardProviderOrderId,
} from "@domain/gift-cards"

/**
 * Pure helpers for the gift card orders repository: record → domain mapping,
 * transition validation, and duplicate-key attribution. No mongoose import, so
 * all of it is unit-testable without a database.
 */

/** Default name mongoose gives the `{ walletId: 1, idempotencyKey: 1 }` unique index. */
export const GIFT_CARD_ORDER_IDEMPOTENCY_INDEX = "walletId_1_idempotencyKey_1"

/**
 * `create` collided on `{ walletId, idempotencyKey }` — a client retry or two
 * concurrent purchases with the same key. Kept distinct from the generic
 * `DuplicateKeyForPersistError` so the app layer can look the existing order up
 * and return it instead of failing the purchase.
 */
export class GiftCardOrderDuplicateKeyError extends RepositoryError {}

/**
 * True only when an E11000 names the idempotency index. Any other duplicate
 * (e.g. `providerId_1_providerOrderId_1`) is a real bug and must keep surfacing
 * as `DuplicateKeyForPersistError` through `parseRepositoryError`.
 */
export const isGiftCardOrderIdempotencyDuplicate = (err: unknown): boolean => {
  if (err === null || err === undefined) return false

  const keyPattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern
  const code = (err as { code?: unknown }).code
  if (
    (code === 11000 || code === "11000") &&
    keyPattern &&
    "walletId" in keyPattern &&
    "idempotencyKey" in keyPattern
  ) {
    return true
  }

  const message = err instanceof Error ? err.message : String(err)
  return (
    /E11000 duplicate key error/.test(message) &&
    message.includes(`index: ${GIFT_CARD_ORDER_IDEMPOTENCY_INDEX}`)
  )
}

/**
 * Every `from` must be allowed to move to `to` per `GIFT_CARD_TRANSITIONS`.
 * Checked before touching Mongo so an illegal request never becomes a write.
 */
export const checkGiftCardOrderTransition = (
  from: readonly GiftCardOrderStatus[],
  to: GiftCardOrderStatus,
): true | GiftCardOrderStateError => {
  if (from.length === 0) {
    return new GiftCardOrderStateError("transition needs at least one source status")
  }
  if (!(to in GIFT_CARD_TRANSITIONS)) {
    return new GiftCardOrderStateError(`unknown target status ${String(to)}`)
  }
  for (const status of from) {
    if (!(status in GIFT_CARD_TRANSITIONS)) {
      return new GiftCardOrderStateError(`unknown source status ${String(status)}`)
    }
    if (!canTransitionGiftCardOrder(status, to)) {
      return new GiftCardOrderStateError(`cannot move ${status} → ${to}`)
    }
  }
  return true
}

export const toDomain = (record: GiftCardOrderRecord): GiftCardOrder => ({
  id: toGiftCardOrderId(record.id),
  accountId: record.accountId as AccountId,
  walletId: record.walletId as WalletId,
  walletCurrency: record.walletCurrency as WalletCurrency,
  providerId: record.providerId as GiftCardProviderId,
  providerProductId: record.providerProductId,
  providerOrderId: record.providerOrderId
    ? toGiftCardProviderOrderId(record.providerOrderId)
    : null,
  productSnapshot: {
    name: record.productSnapshot.name,
    brand: record.productSnapshot.brand,
    countryCode: record.productSnapshot.countryCode,
    currency: record.productSnapshot.currency,
    isOpenLoop: Boolean(record.productSnapshot.isOpenLoop),
    logoUrl: record.productSnapshot.logoUrl ?? null,
  },
  valueMinor: record.valueMinor,
  currency: record.currency,
  quantity: record.quantity,
  quoteSats: record.quoteSats as Satoshis,
  invoiceSats: (record.invoiceSats ?? null) as Satoshis | null,
  paidSats: (record.paidSats ?? null) as Satoshis | null,
  paymentRequest: record.paymentRequest ?? null,
  paymentHash: record.paymentHash ?? null,
  providerPaymentRef: record.providerPaymentRef ?? null,
  idempotencyKey: record.idempotencyKey,
  status: record.status as GiftCardOrderStatus,
  statusHistory: (record.statusHistory ?? []).map((entry) => ({
    status: entry.status as GiftCardOrderStatus,
    at: entry.at,
    reason: entry.reason ?? null,
  })),
  claimCiphertext: record.claimCiphertext ?? null,
  claimKeyId: record.claimKeyId ?? null,
  fulfilledAt: record.fulfilledAt ?? null,
  failureReason: record.failureReason ?? null,
  expiresAt: record.expiresAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})
