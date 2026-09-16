import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import SatAmount from "@graphql/shared/types/scalar/sat-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

/**
 * What the resolver hands this type. The domain `GiftCardQuote` names its money
 * fields `valueMinor` / `fiatCostMinor`; the wire drops the suffix because the
 * `CentAmount` scalar already says minor units. The rename happens ONCE, in
 * `toGiftCardQuoteSource`, so a field added to the domain type cannot reach the
 * wire under the wrong name by accident.
 */
export type GiftCardQuoteSource = {
  productId: string
  value: number
  currency: string
  quantity: number
  fiatCost: number
  satsCost: Satoshis
  rewardSats: Satoshis
  expiresAt: Date
}

export const toGiftCardQuoteSource = (quote: GiftCardQuote): GiftCardQuoteSource => ({
  productId: quote.productId,
  value: quote.valueMinor,
  currency: quote.currency,
  quantity: quote.quantity,
  fiatCost: quote.fiatCostMinor,
  satsCost: quote.satsCost,
  rewardSats: quote.rewardSats,
  expiresAt: quote.expiresAt,
})

const GiftCardQuote = GT.Object<GiftCardQuoteSource>({
  name: "GiftCardQuote",
  description:
    "What a gift card purchase would cost right now. Not a reservation: nothing is " +
    "held and no limit is consumed. giftCardPurchase re-prices at order time and " +
    "refuses to pay if the vendor's invoice drifted past tolerance from this, so a " +
    "stale quote costs a retry, never money.",
  fields: () => ({
    productId: {
      type: GT.NonNullID,
      description: "The product this quote is for, echoed back.",
    },
    value: {
      type: GT.NonNull(CentAmount),
      description: "Face value of ONE card, minor units of `currency`, echoed back.",
    },
    currency: {
      type: GT.NonNull(GT.String),
      description: "ISO 4217 currency of `value` and `fiatCost`.",
    },
    quantity: {
      type: GT.NonNull(GT.Int),
      description: "How many cards the quote covers, echoed back.",
    },
    fiatCost: {
      type: GT.NonNull(CentAmount),
      description:
        "What the vendor charges for the whole order, minor units of `currency`. Can " +
        "differ from value x quantity when the vendor prices below face.",
    },
    satsCost: {
      type: GT.NonNull(SatAmount),
      description:
        "What leaves the wallet for the whole order, in sats, at the vendor's current " +
        "price. This is the number to show as the price.",
    },
    rewardSats: {
      type: GT.NonNull(SatAmount),
      description:
        "Sats the vendor rebates on this order once fulfilled. Zero when the card " +
        "carries no reward.",
    },
    expiresAt: {
      type: GT.NonNull(Timestamp),
      description:
        "After this the vendor no longer honours the price. Ask again before " +
        "purchasing; the purchase itself re-quotes regardless.",
    },
  }),
})

export default GiftCardQuote
