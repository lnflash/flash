import { getGiftCardOrderForAccount } from "@app/gift-cards"
import { GiftCardOrderNotFoundError } from "@domain/gift-cards"
import { mapError } from "@graphql/error-map"
import { GT } from "@graphql/index"
import GiftCardOrder, {
  toGiftCardOrderSource,
} from "@graphql/public/types/object/gift-card-order"

type GiftCardOrderArgs = { id: string }

const GiftCardOrderQuery = GT.Field<null, GraphQLPublicContextAuth, GiftCardOrderArgs>({
  type: GiftCardOrder,
  description:
    "One of the calling account's gift card orders, by id — the endpoint to poll " +
    "after giftCardPurchase, and the ONLY place the claim is returned. Null when " +
    "the id is unknown or belongs to another account; the two are deliberately " +
    "indistinguishable.",
  args: {
    id: {
      type: GT.NonNullID,
      description: "A GiftCardOrder.id from giftCardPurchase or giftCardOrders.",
    },
  },
  resolve: async (_, args, { domainAccount }) => {
    // Deliberately NOT behind the gift card master gate: this is an owner-scoped
    // read of orders the customer already paid for. Switching the rail off (or a
    // provider being disabled for their country) must never hide codes they own.
    // Ownership is enforced in the app layer, which returns NotFound for non-owners.

    // The account id comes from the session, never from an argument: the order
    // id alone cannot name whose order is being read. The app layer answers
    // "not found" for another account's order, which becomes null here.
    const result = await getGiftCardOrderForAccount({
      accountId: domainAccount.id,
      orderId: args.id as GiftCardOrderId,
    })
    if (result instanceof GiftCardOrderNotFoundError) return null
    if (result instanceof Error) throw mapError(result)

    return toGiftCardOrderSource(result.order, result.claim)
  },
})

export default GiftCardOrderQuery
