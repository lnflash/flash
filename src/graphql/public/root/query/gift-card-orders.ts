import { listGiftCardOrdersForAccount } from "@app/gift-cards"
import { InputValidationError } from "@graphql/error"
import { mapError } from "@graphql/error-map"
import { GT } from "@graphql/index"
import {
  GiftCardOrderConnection,
  toGiftCardOrderSource,
} from "@graphql/public/types/object/gift-card-order"

/**
 * Order-list cursors. The app layer pages by `createdAt` (keyset, newest
 * first) and speaks Date; the wire speaks an opaque string. Base64 of the ISO
 * timestamp round-trips to the millisecond, which is the precision the store
 * keeps, so a cursor copied off any edge resumes exactly after that row.
 */
export const encodeGiftCardOrderCursor = (createdAt: Date): string =>
  Buffer.from(createdAt.toISOString(), "utf8").toString("base64")

export const decodeGiftCardOrderCursor = (cursor: string): Date | null => {
  const decoded = Buffer.from(cursor, "base64").toString("utf8")
  const date = new Date(decoded)
  return Number.isNaN(date.getTime()) ? null : date
}

type GiftCardOrdersArgs = { first?: number | null; after?: string | null }

const GiftCardOrdersQuery = GT.Field<null, GraphQLPublicContextAuth, GiftCardOrdersArgs>({
  type: GT.NonNull(GiftCardOrderConnection),
  description:
    "The calling account's gift card orders, newest first. Claims are never part of a " +
    "listing — fetch one order with giftCardOrder(id:) for that.",
  args: {
    first: {
      type: GT.Int,
      description: "Page size, 1 to 100. Defaults to 20.",
    },
    after: {
      type: GT.String,
      description: "The `endCursor` (or any edge cursor) from the previous page.",
    },
  },
  resolve: async (_, args, { domainAccount }) => {
    if (typeof args.first === "number" && args.first < 1) {
      throw new InputValidationError({
        message: 'Argument "first" must be greater than 0',
      })
    }
    let after: Date | undefined
    if (args.after) {
      const decoded = decodeGiftCardOrderCursor(args.after)
      if (decoded === null) {
        throw new InputValidationError({
          message: 'Argument "after" must be a valid cursor',
        })
      }
      after = decoded
    }

    // Deliberately NOT behind the gift card master gate: this is an owner-scoped
    // read of orders the customer already paid for. Switching the rail off (or a
    // provider being disabled for their country) must never hide codes they own.
    // Ownership is enforced in the app layer, which returns NotFound for non-owners.

    const page = await listGiftCardOrdersForAccount({
      accountId: domainAccount.id,
      first: args.first ?? undefined,
      after,
    })
    if (page instanceof Error) throw mapError(page)

    const edges = page.orders.map((order) => ({
      // No claim in a listing, ever: the mapper is called without one.
      node: toGiftCardOrderSource(order),
      cursor: encodeGiftCardOrderCursor(order.createdAt),
    }))
    return {
      edges,
      pageInfo: {
        hasNextPage: page.hasNextPage,
        hasPreviousPage: false,
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor: page.endCursor ? encodeGiftCardOrderCursor(page.endCursor) : null,
      },
    }
  },
})

export default GiftCardOrdersQuery
