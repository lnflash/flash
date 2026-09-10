import { getGiftCardOrderForAccount, purchaseGiftCard } from "@app/gift-cards"
import { GiftCardOrderStatus } from "@domain/gift-cards"
import { InputValidationError } from "@graphql/error"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import { gateGiftCardsForAccount } from "@graphql/public/root/gift-card-gate"
import GiftCardPurchaseInput from "@graphql/public/types/input/gift-card-purchase-input"
import { toGiftCardOrderSource } from "@graphql/public/types/object/gift-card-order"
import GiftCardPurchasePayload from "@graphql/public/types/payload/gift-card-purchase"

// Client-generated, so bounded here rather than trusting the app layer's looser
// storage cap: short keys collide, long keys are someone stuffing the index.
export const GIFT_CARD_IDEMPOTENCY_KEY_MIN_LENGTH = 8
export const GIFT_CARD_IDEMPOTENCY_KEY_MAX_LENGTH = 64

const isValidIdempotencyKey = (key: unknown): key is string =>
  typeof key === "string" &&
  key.length >= GIFT_CARD_IDEMPOTENCY_KEY_MIN_LENGTH &&
  key.length <= GIFT_CARD_IDEMPOTENCY_KEY_MAX_LENGTH &&
  !/\s/.test(key)

type GiftCardPurchaseInputArgs = {
  productId: string
  value: number | InputValidationError
  quantity?: number | null
  walletId: WalletId | InputValidationError
  idempotencyKey: string
}

const GiftCardPurchaseMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  { input: GiftCardPurchaseInputArgs }
>({
  extensions: { complexity: 120 },
  type: GT.NonNull(GiftCardPurchasePayload),
  description:
    "Buy a gift card: pays the vendor from `walletId` over Lightning and returns the " +
    "order. Re-prices at order time and refuses to pay if the price drifted past " +
    "tolerance from the quote — no money moves on a refusal. Money moves at most once " +
    "per idempotencyKey, so retry a timed-out call with the SAME key.",
  args: {
    input: { type: GT.NonNull(GiftCardPurchaseInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { productId, value, walletId, idempotencyKey } = args.input
    const quantity = args.input.quantity ?? 1

    // What the scalars hand back for a bad value is an InputValidationError — an
    // Apollo error, NOT an ApplicationError. Run through the error map it falls
    // off the end of the switch and throws `assertUnreachable`. Same handling as
    // every other scalar-validated mutation (see fygaro-checkout-create).
    if (value instanceof Error) return { errors: [{ message: value.message }] }
    if (walletId instanceof Error) return { errors: [{ message: walletId.message }] }
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return {
        errors: [
          {
            message:
              `idempotencyKey must be ${GIFT_CARD_IDEMPOTENCY_KEY_MIN_LENGTH} to ` +
              `${GIFT_CARD_IDEMPOTENCY_KEY_MAX_LENGTH} characters with no whitespace`,
          },
        ],
      }
    }

    // The deploy-level gate, before anything else — the same one the catalog
    // and quote opened with, so nothing offered upstream is refused here for a
    // different reason. `purchaseGiftCard` gates again internally (it must stand
    // alone); the cost is one user read.
    const gate = await gateGiftCardsForAccount({ account: domainAccount })
    if (!gate.ok) return { errors: [mapAndParseErrorForGqlResponse(gate.error)] }

    // The purchase attempt budget (RateLimitConfig.giftCardPurchase) is consumed
    // INSIDE purchaseGiftCard, before any vendor or store round-trip. Not here:
    // charging it twice would halve every customer's allowance.
    const order = await purchaseGiftCard({
      accountId: domainAccount.id,
      walletId,
      productId,
      valueMinor: value,
      quantity,
      idempotencyKey,
    })
    if (order instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(order)] }
    }

    if (order.status !== GiftCardOrderStatus.Fulfilled) {
      return { errors: [], order: toGiftCardOrderSource(order) }
    }

    // Already fulfilled on the purchase's own first poll: hand over the claim
    // now and save the client a round trip. The decrypt lives in ONE place — the
    // owner-scoped read — so it is called rather than re-implemented. If the
    // claim cannot be read, the order is still returned (the card IS issued) and
    // the error rides alongside so the client does not show a FULFILLED order
    // with a silently empty claim.
    const withClaim = await getGiftCardOrderForAccount({
      accountId: domainAccount.id,
      orderId: order.id,
    })
    if (withClaim instanceof Error) {
      return {
        errors: [mapAndParseErrorForGqlResponse(withClaim)],
        order: toGiftCardOrderSource(order),
      }
    }

    return { errors: [], order: toGiftCardOrderSource(withClaim.order, withClaim.claim) }
  },
})

export default GiftCardPurchaseMutation
