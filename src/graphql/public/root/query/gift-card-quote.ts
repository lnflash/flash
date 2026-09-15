import { quoteGiftCard } from "@app/gift-cards"
import { InputValidationError } from "@graphql/error"
import { mapError } from "@graphql/error-map"
import { GT } from "@graphql/index"
import { gateGiftCardsForAccount } from "@graphql/public/root/gift-card-gate"
import GiftCardQuote, {
  toGiftCardQuoteSource,
} from "@graphql/public/types/object/gift-card-quote"
import CentAmount from "@graphql/public/types/scalar/cent-amount"

type GiftCardQuoteArgs = {
  productId: string
  value: number | InputValidationError
  quantity?: number | null
}

const GiftCardQuoteQuery = GT.Field<null, GraphQLPublicContextAuth, GiftCardQuoteArgs>({
  extensions: { complexity: 120 }, // one live vendor POST per resolve; see giftCardPurchase
  type: GT.NonNull(GiftCardQuote),
  description:
    "What a purchase would cost right now, in sats, for a product at a face value. " +
    "Refuses exactly what giftCardPurchase would refuse — a value off the card's " +
    "denominations, a card not sold in the account's country, a sold-out card — so " +
    "the client can surface that before asking the customer to confirm.",
  args: {
    productId: {
      type: GT.NonNullID,
      description: "A GiftCardProduct.id from giftCardCatalog.",
    },
    value: {
      type: GT.NonNull(CentAmount),
      description:
        "Face value of ONE card, minor units of the product's currency. Must be one of " +
        "the product's denominations (FIXED) or within minValue..maxValue (VARIABLE).",
    },
    quantity: {
      type: GT.Int,
      defaultValue: 1,
      description: "How many cards, 1 to 10. Defaults to 1.",
    },
  },
  resolve: async (_, args, { domainAccount }) => {
    // CentAmount hands back an InputValidationError for a negative, oversized or
    // non-integer value. It is an Apollo error already; thrown, not mapped.
    if (args.value instanceof Error) throw args.value
    const quantity = args.quantity ?? 1
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new InputValidationError({
        message: 'Argument "quantity" must be a whole number greater than 0',
      })
    }

    const gate = await gateGiftCardsForAccount({ account: domainAccount })
    if (!gate.ok) throw mapError(gate.error)

    const quote = await quoteGiftCard({
      accountId: domainAccount.id,
      productId: args.productId,
      valueMinor: args.value,
      quantity,
    })
    if (quote instanceof Error) throw mapError(quote)

    return toGiftCardQuoteSource(quote)
  },
})

export default GiftCardQuoteQuery
