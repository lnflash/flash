import { GiftCardOrdersRepository } from "@services/mongoose"

export const GIFT_CARD_ORDERS_DEFAULT_FIRST = 20
export const GIFT_CARD_ORDERS_MAX_FIRST = 100

export type GiftCardOrderPage = {
  orders: GiftCardOrder[]
  hasNextPage: boolean
  /** `createdAt` of the last order on the page, to pass back as `after`. */
  endCursor: Date | null
}

const clampFirst = (first: number | undefined): number => {
  if (first === undefined || !Number.isFinite(first) || first < 1) {
    return GIFT_CARD_ORDERS_DEFAULT_FIRST
  }
  return Math.min(Math.floor(first), GIFT_CARD_ORDERS_MAX_FIRST)
}

/**
 * The account's orders, newest first, keyset-paginated on `createdAt`. Claim
 * data is never part of a listing — `claimCiphertext` rides along on the
 * order but is only ever decrypted by `getGiftCardOrderForAccount`.
 */
export const listGiftCardOrdersForAccount = async ({
  accountId,
  first,
  after,
}: {
  accountId: AccountId
  first?: number
  after?: Date
}): Promise<GiftCardOrderPage | ApplicationError> => {
  const limit = clampFirst(first)
  // One extra row tells us whether another page exists without a count query.
  const rows = await GiftCardOrdersRepository().listByAccount({
    accountId,
    limit: limit + 1,
    before: after,
  })
  if (rows instanceof Error) return rows

  const orders = rows.slice(0, limit)
  const last = orders[orders.length - 1]
  return {
    orders,
    hasNextPage: rows.length > limit,
    endCursor: last ? last.createdAt : null,
  }
}
