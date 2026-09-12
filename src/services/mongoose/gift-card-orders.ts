import { randomUUID } from "crypto"

import { RepositoryError } from "@domain/errors"
import {
  GiftCardOrderNotFoundError,
  GiftCardOrderStateError,
  GiftCardOrderStatus,
} from "@domain/gift-cards"

import { parseRepositoryError } from "./utils"
import { GiftCardOrders } from "./schema"
import {
  GiftCardOrderDuplicateKeyError,
  checkGiftCardOrderTransition,
  isGiftCardOrderIdempotencyDuplicate,
  toDomain,
} from "./gift-card-orders.mapping"

export {
  GiftCardOrderDuplicateKeyError,
  GIFT_CARD_ORDER_IDEMPOTENCY_INDEX,
} from "./gift-card-orders.mapping"

export type NewGiftCardOrderArgs = {
  accountId: AccountId
  walletId: WalletId
  walletCurrency: WalletCurrency
  providerId: GiftCardProviderId
  providerProductId: string
  productSnapshot: GiftCardProductSnapshot
  valueMinor: number
  currency: string
  quantity: number
  quoteSats: Satoshis
  idempotencyKey: string
  expiresAt: Date
}

export type GiftCardOrderPatch = Partial<
  Pick<
    GiftCardOrder,
    | "providerOrderId"
    | "paymentRequest"
    | "invoiceSats"
    | "paidSats"
    | "paymentHash"
    | "providerPaymentRef"
    | "claimCiphertext"
    | "claimKeyId"
    | "fulfilledAt"
    | "failureReason"
    | "expiresAt"
  >
>

export type GiftCardOrderTransitionArgs = {
  id: GiftCardOrderId
  from: GiftCardOrderStatus[]
  to: GiftCardOrderStatus
  reason?: string
  patch?: GiftCardOrderPatch
}

export interface IGiftCardOrdersRepository {
  create(args: NewGiftCardOrderArgs): Promise<GiftCardOrder | RepositoryError>
  findById(
    id: GiftCardOrderId,
  ): Promise<GiftCardOrder | GiftCardOrderNotFoundError | RepositoryError>
  findByIdempotencyKey(args: {
    walletId: WalletId
    idempotencyKey: string
  }): Promise<GiftCardOrder | GiftCardOrderNotFoundError | RepositoryError>
  findByProviderOrderId(args: {
    providerId: GiftCardProviderId
    providerOrderId: GiftCardProviderOrderId
  }): Promise<GiftCardOrder | GiftCardOrderNotFoundError | RepositoryError>
  listByAccount(args: {
    accountId: AccountId
    limit: number
    before?: Date
  }): Promise<GiftCardOrder[] | RepositoryError>
  listByStatus(args: {
    statuses: GiftCardOrderStatus[]
    updatedBefore?: Date
    limit: number
  }): Promise<GiftCardOrder[] | RepositoryError>
  transition(
    args: GiftCardOrderTransitionArgs,
  ): Promise<
    GiftCardOrder | GiftCardOrderStateError | GiftCardOrderNotFoundError | RepositoryError
  >
  /**
   * Bump `updatedAt` without changing anything else. The reconcile worker
   * calls this after a poll that left the status where it was, so
   * `listByStatus` (oldest `updatedAt` first) rotates through a batch instead
   * of pinning the same stuck rows at the front of every run.
   */
  touch(id: GiftCardOrderId): Promise<true | GiftCardOrderNotFoundError | RepositoryError>
}

/**
 * Persistence for gift card orders. Every status move goes through
 * `transition`, which is a single conditional `findOneAndUpdate` on the current
 * status — the DB is the arbiter when two workers race, and the loser gets a
 * `GiftCardOrderStateError` instead of silently overwriting.
 *
 * Functions return errors; they never throw.
 */
export const GiftCardOrdersRepository = (): IGiftCardOrdersRepository => {
  const create = async (
    args: NewGiftCardOrderArgs,
  ): Promise<GiftCardOrder | RepositoryError> => {
    try {
      const now = new Date()
      const record = await GiftCardOrders.create({
        id: randomUUID(),
        accountId: args.accountId,
        walletId: args.walletId,
        walletCurrency: args.walletCurrency,
        providerId: args.providerId,
        providerProductId: args.providerProductId,
        providerOrderId: null,
        productSnapshot: {
          name: args.productSnapshot.name,
          brand: args.productSnapshot.brand,
          countryCode: args.productSnapshot.countryCode,
          currency: args.productSnapshot.currency,
          isOpenLoop: args.productSnapshot.isOpenLoop,
          logoUrl: args.productSnapshot.logoUrl,
        },
        valueMinor: args.valueMinor,
        currency: args.currency,
        quantity: args.quantity,
        quoteSats: args.quoteSats,
        invoiceSats: null,
        paidSats: null,
        paymentRequest: null,
        paymentHash: null,
        providerPaymentRef: null,
        idempotencyKey: args.idempotencyKey,
        status: GiftCardOrderStatus.Created,
        statusHistory: [{ status: GiftCardOrderStatus.Created, at: now, reason: null }],
        claimCiphertext: null,
        claimKeyId: null,
        fulfilledAt: null,
        failureReason: null,
        expiresAt: args.expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      return toDomain(record)
    } catch (err) {
      if (isGiftCardOrderIdempotencyDuplicate(err)) {
        return new GiftCardOrderDuplicateKeyError(
          "A gift card order with this idempotency key already exists for this wallet",
        )
      }
      return parseRepositoryError(err)
    }
  }

  const findById = async (
    id: GiftCardOrderId,
  ): Promise<GiftCardOrder | GiftCardOrderNotFoundError | RepositoryError> => {
    try {
      const record = await GiftCardOrders.findOne({ id: { $eq: id } })
      if (!record) return new GiftCardOrderNotFoundError()
      return toDomain(record)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const findByIdempotencyKey = async ({
    walletId,
    idempotencyKey,
  }: {
    walletId: WalletId
    idempotencyKey: string
  }): Promise<GiftCardOrder | GiftCardOrderNotFoundError | RepositoryError> => {
    try {
      const record = await GiftCardOrders.findOne({
        walletId: { $eq: walletId },
        idempotencyKey: { $eq: idempotencyKey },
      })
      if (!record) return new GiftCardOrderNotFoundError()
      return toDomain(record)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const findByProviderOrderId = async ({
    providerId,
    providerOrderId,
  }: {
    providerId: GiftCardProviderId
    providerOrderId: GiftCardProviderOrderId
  }): Promise<GiftCardOrder | GiftCardOrderNotFoundError | RepositoryError> => {
    try {
      const record = await GiftCardOrders.findOne({
        providerId: { $eq: providerId },
        providerOrderId: { $eq: providerOrderId },
      })
      if (!record) return new GiftCardOrderNotFoundError()
      return toDomain(record)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  /** Newest first; `before` pages by `createdAt` (exclusive). */
  const listByAccount = async ({
    accountId,
    limit,
    before,
  }: {
    accountId: AccountId
    limit: number
    before?: Date
  }): Promise<GiftCardOrder[] | RepositoryError> => {
    try {
      const records = await GiftCardOrders.find({
        accountId: { $eq: accountId },
        ...(before ? { createdAt: { $lt: before } } : {}),
      })
        .sort({ createdAt: -1 })
        .limit(limit)
      return records.map(toDomain)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  /** Oldest `updatedAt` first — the reconciler works the stalest orders first. */
  const listByStatus = async ({
    statuses,
    updatedBefore,
    limit,
  }: {
    statuses: GiftCardOrderStatus[]
    updatedBefore?: Date
    limit: number
  }): Promise<GiftCardOrder[] | RepositoryError> => {
    try {
      const records = await GiftCardOrders.find({
        status: { $in: statuses },
        ...(updatedBefore ? { updatedAt: { $lt: updatedBefore } } : {}),
      })
        .sort({ updatedAt: 1 })
        .limit(limit)
      return records.map(toDomain)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const transition = async ({
    id,
    from,
    to,
    reason,
    patch = {},
  }: GiftCardOrderTransitionArgs): Promise<
    GiftCardOrder | GiftCardOrderStateError | GiftCardOrderNotFoundError | RepositoryError
  > => {
    const allowed = checkGiftCardOrderTransition(from, to)
    if (allowed instanceof Error) return allowed

    try {
      const now = new Date()
      const record = await GiftCardOrders.findOneAndUpdate(
        { id: { $eq: id }, status: { $in: from } },
        {
          $set: { ...patch, status: to, updatedAt: now },
          $push: { statusHistory: { status: to, at: now, reason: reason ?? null } },
        },
        { new: true },
      )
      if (record) return toDomain(record)

      // No document matched the conditional update: either the order does not
      // exist or it has already moved on. Read it back to tell the caller which.
      const current = await GiftCardOrders.findOne({ id: { $eq: id } })
      if (!current) return new GiftCardOrderNotFoundError()
      return new GiftCardOrderStateError(`cannot move ${current.status} → ${to}`)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const touch = async (
    id: GiftCardOrderId,
  ): Promise<true | GiftCardOrderNotFoundError | RepositoryError> => {
    try {
      const result = await GiftCardOrders.updateOne(
        { id: { $eq: id } },
        { $set: { updatedAt: new Date() } },
      )
      if (result.matchedCount === 0) return new GiftCardOrderNotFoundError()
      return true
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  return {
    create,
    findById,
    findByIdempotencyKey,
    findByProviderOrderId,
    listByAccount,
    listByStatus,
    transition,
    touch,
  }
}
