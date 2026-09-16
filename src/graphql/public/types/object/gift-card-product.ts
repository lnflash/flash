import { connectionDefinitions } from "@graphql/connections"
import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import CountryCode from "@graphql/public/types/scalar/country-code"

/**
 * The INTERNAL value behind each enum member — what the catalog row actually
 * carries, so GraphQL can serialize the member's name onto the wire.
 *
 * Typed as the domain's `GiftCardDenominationType` for the reason the Fygaro
 * enums type theirs (`fygaro-topup-status.ts`): as bare literals the two wire
 * strings would live in the adapter's normaliser AND here with nothing linking
 * them, and a rename on either side would compile, pass every test, then throw
 * `Enum "GiftCardDenominationType" cannot represent value` at every customer
 * opening the catalog.
 */
const DENOMINATION_TYPE_VALUES: Record<
  string,
  { value: GiftCardDenominationType; description: string }
> = {
  FIXED: {
    value: "fixed",
    description:
      "The card is sold only at the amounts listed in `denominations`; `minValue` and " +
      "`maxValue` are null. A purchase at any other value is refused.",
  },
  VARIABLE: {
    value: "variable",
    description:
      "Any whole amount from `minValue` to `maxValue` inclusive; `denominations` is empty.",
  },
}

export const GiftCardDenominationTypeEnum = GT.Enum({
  name: "GiftCardDenominationType",
  values: DENOMINATION_TYPE_VALUES,
})

const GiftCardProduct = GT.Object<GiftCardProduct>({
  name: "GiftCardProduct",
  description:
    "One purchasable gift card in the catalog for a country. Money fields are minor " +
    "units of `currency` (cents for USD); they are face values, not what the customer " +
    "pays in sats — ask giftCardQuote for that.",
  fields: () => ({
    id: {
      type: GT.NonNullID,
      description:
        "Pass to giftCardQuote and giftCardPurchase. Opaque; stable across catalog " +
        "refreshes for the same card.",
    },
    name: {
      type: GT.NonNull(GT.String),
      description: "Display name of the card, e.g. 'Amazon.com Gift Card'.",
    },
    brand: {
      type: GT.NonNull(GT.String),
      description:
        "The merchant whose card this is. Catalog order is by brand, then name.",
    },
    countryCode: {
      type: GT.NonNull(CountryCode),
      description: "The country the card is redeemable in.",
    },
    currency: {
      type: GT.NonNull(GT.String),
      description: "ISO 4217 currency of every money field on this product.",
    },
    denominationType: {
      type: GT.NonNull(GiftCardDenominationTypeEnum),
      description: "Whether the card is sold at fixed amounts or any amount in a range.",
    },
    denominations: {
      type: GT.NonNullList(CentAmount),
      description:
        "The purchasable face values for a FIXED card, minor units, ascending. Empty " +
        "for a VARIABLE card.",
    },
    minValue: {
      type: CentAmount,
      description:
        "Smallest face value for a VARIABLE card, minor units. Null for FIXED.",
    },
    maxValue: {
      type: CentAmount,
      description: "Largest face value for a VARIABLE card, minor units. Null for FIXED.",
    },
    isOpenLoop: {
      type: GT.NonNull(GT.Boolean),
      description:
        "True for a network-branded prepaid card (Visa/Mastercard-style) spendable " +
        "anywhere, as opposed to a single-merchant card. Only listed when the operator " +
        "allows them.",
    },
    categories: {
      type: GT.NonNullList(GT.String),
      description:
        "Vendor-supplied grouping labels, e.g. 'Shopping'. Any one of them can be " +
        "passed back as giftCardCatalog(category:) to filter.",
    },
    logoUrl: {
      type: GT.String,
      description: "Brand artwork, when the vendor supplies one.",
    },
    termsUrl: {
      type: GT.String,
      description: "The card's terms and conditions, when the vendor supplies a link.",
    },
    rewardBps: {
      type: GT.NonNull(GT.Int),
      description:
        "Vendor reward on face value, in basis points (100 = 1%). Informational; the " +
        "sats actually rebated for a given purchase are on the quote as rewardSats.",
    },
    maxQuantity: {
      type: GT.NonNull(GT.Int),
      description:
        "Largest quantity a single order may carry for this product. Vendor-specific; " +
        "1 while a vendor's multi-card fulfilment response has not been verified.",
    },
    wholeUnitsOnly: {
      type: GT.NonNull(GT.Boolean),
      description:
        "True when the vendor only accepts whole currency units for a variable-value " +
        "card (no cents). Values that are not a multiple of 100 minor units are refused.",
    },
  }),
})

export const { connectionType: GiftCardProductConnection } = connectionDefinitions({
  nodeType: GiftCardProduct,
})

export default GiftCardProduct
