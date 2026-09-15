import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

const GiftCardPurchaseInput = GT.Input({
  name: "GiftCardPurchaseInput",
  fields: () => ({
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
    walletId: {
      type: GT.NonNull(WalletId),
      description:
        "The wallet that pays. Must belong to the calling account; the sats cost from " +
        "giftCardQuote is what leaves it.",
    },
    idempotencyKey: {
      type: GT.NonNull(GT.String),
      description:
        "Client-generated, 8 to 64 characters, unique per purchase attempt (a UUID is " +
        "ideal). Retrying with the SAME key and the same product/value/quantity returns " +
        "the existing order instead of buying again; the same key with different " +
        "parameters is refused. Generate a new key for a genuinely new purchase.",
    },
  }),
})

export default GiftCardPurchaseInput
