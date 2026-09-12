import { getGiftCardOrderForAccount } from "@app/gift-cards"
import { GiftCardOrderNotFoundError } from "@domain/gift-cards"
import { ErrorLevel } from "@domain/shared"
import { mapError } from "@graphql/error-map"
import { GT } from "@graphql/index"
import GiftCardOrder, {
  toGiftCardOrderSource,
} from "@graphql/public/types/object/gift-card-order"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"

type GiftCardOrderArgs = { id: string }

const GiftCardOrderQuery = GT.Field<null, GraphQLPublicContextAuth, GiftCardOrderArgs>({
  type: GiftCardOrder,
  description:
    "One of the calling account's gift card orders, by id — the endpoint to poll " +
    "after giftCardPurchase, and the ONLY place the claim is returned. Null when " +
    "the id is unknown or belongs to another account; the two are deliberately " +
    "indistinguishable. A FULFILLED order whose claim cannot currently be read is " +
    "still returned, with `claim` null.",
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

    if (result.claimError) {
      // The order is real, paid for, and the caller's; the only thing wrong is
      // that its claim will not decrypt right now (key rotated, or this pod has
      // stale config). Throwing here would hide the order itself — the customer
      // could not even see it exists. Return it with `claim` null and page on
      // the fault: a FULFILLED order nobody can read is a Critical until fixed.
      // The key id is a fingerprint, safe to log; the ciphertext never is.
      recordExceptionInCurrentSpan({
        error: result.claimError,
        level: ErrorLevel.Critical,
        attributes: {
          "giftcard.orderId": result.order.id,
          "giftcard.claimKeyId": result.order.claimKeyId ?? undefined,
        },
      })
      baseLogger.error(
        {
          orderId: result.order.id,
          claimKeyId: result.order.claimKeyId,
          error: result.claimError.constructor.name,
          reason: result.claimError.message,
        },
        "Gift card claim could not be read for a FULFILLED order",
      )
    }

    return toGiftCardOrderSource(result.order, result.claim)
  },
})

export default GiftCardOrderQuery
