import { GiftCardOrderStatus as OrderStatus } from "@domain/gift-cards"
import { connectionDefinitions } from "@graphql/connections"
import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import CountryCode from "@graphql/public/types/scalar/country-code"
import SatAmount from "@graphql/shared/types/scalar/sat-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

/**
 * The INTERNAL value behind each enum member, typed as the domain's
 * `GiftCardOrderStatus` (pattern: `fygaro-topup-status.ts`). The domain's
 * lifecycle constants are already the wire spelling, so a member added to the
 * domain without a row here, or a row whose `value:` drifts, is a compile
 * error instead of `Enum "GiftCardOrderStatus" cannot represent value` at the
 * customer polling their order.
 */
const STATUS_ENUM_VALUES: Record<
  string,
  { value: GiftCardOrderStatus; description: string }
> = {
  CREATED: {
    value: OrderStatus.Created,
    description:
      "The order exists and the vendor has not yet been asked for an invoice. " +
      "Transient; nothing has left the wallet. Keep polling.",
  },
  INVOICE_ISSUED: {
    value: OrderStatus.InvoiceIssued,
    description:
      "The vendor's invoice is in hand and is about to be paid from the wallet. " +
      "Transient. Keep polling.",
  },
  PAYMENT_PENDING: {
    value: OrderStatus.PaymentPending,
    description:
      "The Lightning payment is in flight and has neither settled nor failed. " +
      "Transient, and can take minutes on a slow route. Keep polling; do not " +
      "purchase again.",
  },
  PAID: {
    value: OrderStatus.Paid,
    description:
      "The wallet has paid the vendor and the card is being issued. Transient. Keep polling.",
  },
  FULFILLED: {
    value: OrderStatus.Fulfilled,
    description:
      "Terminal. The card is issued; `claim` carries the redemption data and " +
      "`fulfilledAt` says when.",
  },
  FAILED: {
    value: OrderStatus.Failed,
    description:
      "Terminal. Refused BEFORE any payment left the wallet: the vendor rejected the " +
      "order, the price moved past tolerance, or the invoice could not be read. " +
      "`failureReason` says which. Nothing to refund; safe to try again.",
  },
  PAYMENT_FAILED: {
    value: OrderStatus.PaymentFailed,
    description:
      "Terminal. Only proven refusals land here (insufficient balance, a rejected " +
      "send, a bad idempotency key): nothing left the wallet and it is safe to try " +
      "again with a new idempotencyKey. An indeterminate send error goes to " +
      "PAYMENT_PENDING instead, never here.",
  },
  EXPIRED: {
    value: OrderStatus.Expired,
    description:
      "Terminal. The invoice was not paid before it expired; nothing left the wallet.",
  },
  REFUND_REQUIRED: {
    value: OrderStatus.RefundRequired,
    description:
      "Terminal. The wallet paid but the vendor did not deliver a card. Flash has " +
      "been alerted and will make it right; there is nothing for the customer to do " +
      "and they must NOT be told to buy again.",
  },
}

export const GiftCardOrderStatusEnum = GT.Enum({
  name: "GiftCardOrderStatus",
  values: STATUS_ENUM_VALUES,
})

const GiftCardProductSnapshot = GT.Object<GiftCardProductSnapshot>({
  name: "GiftCardProductSnapshot",
  description:
    "The product as it was when the order was placed. Frozen on the order so a " +
    "catalog refresh (rename, delisting) never changes what a past order says it bought.",
  fields: () => ({
    name: { type: GT.NonNull(GT.String), description: "Display name at purchase time." },
    brand: { type: GT.NonNull(GT.String), description: "Merchant at purchase time." },
    countryCode: {
      type: GT.NonNull(CountryCode),
      description: "Country the card is redeemable in.",
    },
    currency: {
      type: GT.NonNull(GT.String),
      description: "ISO 4217 currency of the order's `value`.",
    },
    isOpenLoop: {
      type: GT.NonNull(GT.Boolean),
      description: "True for a network-branded prepaid card spendable anywhere.",
    },
    logoUrl: { type: GT.String, description: "Brand artwork at purchase time, if any." },
  }),
})

const GiftCardClaimCode = GT.Object<GiftCardClaimCode>({
  name: "GiftCardClaimCode",
  description: "One redeemable code on a fulfilled card.",
  fields: () => ({
    label: {
      type: GT.String,
      description:
        "What the vendor calls this code, e.g. 'Card number', 'PIN'. Null when the " +
        "card has a single unlabelled code.",
    },
    value: {
      type: GT.NonNull(GT.String),
      description:
        "The code itself. Bearer data: show it, let the customer copy it, never log it.",
    },
  }),
})

const GiftCardBarcode = GT.Object<GiftCardBarcode>({
  name: "GiftCardBarcode",
  description: "A scannable representation of the claim, when the vendor supplies one.",
  fields: () => ({
    chars: {
      type: GT.NonNull(GT.String),
      description: "The characters to encode into the barcode.",
    },
    type: {
      type: GT.NonNull(GT.String),
      description:
        "The barcode symbology, e.g. 'CODE128', 'QR'. Vendor-supplied; render accordingly.",
    },
  }),
})

const GiftCardClaim = GT.Object<GiftCardClaim>({
  name: "GiftCardClaim",
  description:
    "The redemption data for a FULFILLED order. Bearer data: anyone holding it can " +
    "spend the card. Returned only to the owning account, only once fulfilled, and " +
    "never in a list — fetch it with giftCardOrder(id:).",
  fields: () => ({
    codes: {
      type: GT.NonNullList(GiftCardClaimCode),
      description:
        "The code(s) to redeem. Usually one; some cards carry a number and a PIN.",
    },
    claimLink: {
      type: GT.String,
      description:
        "A vendor page where the card can be viewed or redeemed, when one exists.",
    },
    barcode: {
      type: GiftCardBarcode,
      description:
        "Scannable form of the claim for in-store use, when the vendor supplies one.",
    },
  }),
})

/**
 * What a resolver hands the `GiftCardOrder` type.
 *
 * An explicit allow-list rather than the domain order itself: the domain row
 * carries `claimCiphertext` and `claimKeyId`, and the safest way to guarantee
 * neither can ever reach the wire — through a future field, a debug resolver,
 * or a misnamed alias — is for the object GraphQL resolves against to not have
 * them at all. `toGiftCardOrderSource` is the ONLY way to build one.
 */
export type GiftCardOrderSource = {
  id: GiftCardOrderId
  status: GiftCardOrderStatus
  product: GiftCardProductSnapshot
  value: number
  currency: string
  quantity: number
  paidSats: Satoshis | null
  claim: GiftCardClaim | null
  createdAt: Date
  fulfilledAt: Date | null
  failureReason: string | null
}

/**
 * `claim` is attached only when the order is FULFILLED, whatever the caller
 * passes. The app layer (`getGiftCardOrderForAccount`) already decrypts only
 * for the owner and only once fulfilled; this is the belt to that braces.
 */
export const toGiftCardOrderSource = (
  order: GiftCardOrder,
  claim: GiftCardClaim | null = null,
): GiftCardOrderSource => ({
  id: order.id,
  status: order.status,
  product: order.productSnapshot,
  value: order.valueMinor,
  currency: order.currency,
  quantity: order.quantity,
  paidSats: order.paidSats,
  claim: order.status === OrderStatus.Fulfilled ? claim : null,
  createdAt: order.createdAt,
  fulfilledAt: order.fulfilledAt,
  failureReason: order.failureReason,
})

const GiftCardOrder = GT.Object<GiftCardOrderSource>({
  name: "GiftCardOrder",
  description:
    "A gift card purchase, from creation through fulfilment. Poll giftCardOrder(id:) " +
    "while `status` is transient; the claim appears once it is FULFILLED.",
  fields: () => ({
    id: {
      type: GT.NonNullID,
      description:
        "Pass to giftCardOrder(id:) to poll. Stable for the life of the order.",
    },
    status: {
      type: GT.NonNull(GiftCardOrderStatusEnum),
      description:
        "Where the order is in its lifecycle. See each value for what to show.",
    },
    product: {
      type: GT.NonNull(GiftCardProductSnapshot),
      description: "The card that was bought, as it was at purchase time.",
    },
    value: {
      type: GT.NonNull(CentAmount),
      description: "Face value of ONE card, minor units of `currency`.",
    },
    currency: {
      type: GT.NonNull(GT.String),
      description: "ISO 4217 currency of `value`.",
    },
    quantity: {
      type: GT.NonNull(GT.Int),
      description: "How many cards the order is for.",
    },
    paidSats: {
      type: SatAmount,
      description:
        "The vendor invoice amount in sats — what was paid for the card, excluding " +
        "the Lightning routing fee. Null until the payment settles (and forever null " +
        "for an order that never paid).",
    },
    claim: {
      type: GiftCardClaim,
      description:
        "The redemption data. Present ONLY when status is FULFILLED and ONLY via " +
        "giftCardOrder(id:) or the purchase payload — never in giftCardOrders.",
    },
    createdAt: {
      type: GT.NonNull(Timestamp),
      description: "When the order was placed.",
    },
    fulfilledAt: {
      type: Timestamp,
      description: "When the card was issued. Null until FULFILLED.",
    },
    failureReason: {
      type: GT.String,
      description:
        "Short machine-oriented reason for a FAILED / PAYMENT_FAILED / REFUND_REQUIRED " +
        "order, for support and diagnostics. Not customer wording; choose the copy from " +
        "`status`.",
    },
  }),
})

export const { connectionType: GiftCardOrderConnection } = connectionDefinitions({
  nodeType: GiftCardOrder,
})

export default GiftCardOrder
