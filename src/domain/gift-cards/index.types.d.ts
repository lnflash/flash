// Gift card domain types. Ambient (no exports) to match the rest of `src/domain`.

type GiftCardProviderId = "bitcoinCompany" | "bitrefill"

/** Flash-scoped product id: `<providerId>:<providerProductId>`. */
type GiftCardProductId = string & { readonly brand: unique symbol }
type GiftCardOrderId = string & { readonly brand: unique symbol }
type GiftCardProviderOrderId = string & { readonly brand: unique symbol }

type GiftCardDenominationType = "fixed" | "variable"

/**
 * Normalised catalog row. Money is in minor units of `currency` (cents for USD).
 * Vendor-specific fields never leak past the adapter.
 */
type GiftCardProduct = {
  readonly id: GiftCardProductId
  readonly providerId: GiftCardProviderId
  readonly providerProductId: string
  readonly name: string
  readonly brand: string
  readonly countryCode: string // ISO 3166-1 alpha-2, upper case
  readonly currency: string // ISO 4217
  readonly denominationType: GiftCardDenominationType
  readonly denominations: readonly number[] // minor units; empty for variable
  readonly minValue: number | null // minor units; variable only
  readonly maxValue: number | null // minor units; variable only
  readonly isOpenLoop: boolean
  readonly categories: readonly string[]
  readonly logoUrl: string | null
  readonly termsUrl: string | null
  readonly rewardBps: number // vendor reward/commission on face value, basis points
  readonly inStock: boolean
  /**
   * Cards the vendor will fulfil in one order. Flash clamps the request to
   * `min(maxQuantity, GIFT_CARD_MAX_QUANTITY)`; adapters set 1 until a vendor's
   * multi-card response shape has been captured and validated.
   */
  readonly maxQuantity: number
  /** Variable-value cards that refuse cents (e.g. TBC "VariableNoCents"). */
  readonly wholeUnitsOnly: boolean
}

type GiftCardQuote = {
  readonly productId: GiftCardProductId
  readonly valueMinor: number
  readonly currency: string
  readonly quantity: number
  readonly fiatCostMinor: number // what the vendor charges, minor units of `currency`
  readonly satsCost: Satoshis
  readonly rewardSats: Satoshis
  readonly bitcoinPriceMinor: number | null // vendor's BTC price in minor units, informational
  readonly expiresAt: Date
}

type GiftCardClaimCode = { readonly label: string | null; readonly value: string }

type GiftCardBarcode = { readonly chars: string; readonly type: string }

/** Bearer data. Encrypted at rest; never logged, traced, or placed in ops events. */
type GiftCardClaim = {
  readonly codes: readonly GiftCardClaimCode[]
  readonly claimLink: string | null
  readonly barcode: GiftCardBarcode | null
}

type GiftCardProviderOrder = {
  readonly providerOrderId: GiftCardProviderOrderId
  readonly paymentRequest: string // BOLT11
  readonly amountSats: Satoshis
  /**
   * Vendor-stated order expiry, when the vendor reports one; null when it does
   * not. Adapters never fabricate it: the BOLT11's own expiry is decoded by
   * `purchaseGiftCard` and bounds how long the order stays payable.
   */
  readonly expiresAt: Date | null
}

type GiftCardProviderOrderStatus =
  | { readonly kind: "awaitingPayment" }
  | { readonly kind: "paidPendingFulfillment" }
  | { readonly kind: "fulfilled"; readonly claim: GiftCardClaim }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "refunded"; readonly reason: string }

type GiftCardProviderOrderRef = {
  readonly providerOrderId: GiftCardProviderOrderId
  readonly paymentRequest: string | null
}

/** The port every vendor adapter implements. Pure vendor I/O; no Flash policy. */
interface IGiftCardProvider {
  readonly id: GiftCardProviderId
  /** Full catalog across all countries. Called by the sync job only, never on a request path. */
  listProducts(): Promise<GiftCardProduct[] | GiftCardError>
  quote(args: {
    product: GiftCardProduct
    valueMinor: number
    quantity: number
  }): Promise<GiftCardQuote | GiftCardError>
  createOrder(args: {
    product: GiftCardProduct
    valueMinor: number
    quantity: number
    /** Our order id; passed to the vendor as a label/reference where supported. */
    reference: GiftCardOrderId
  }): Promise<GiftCardProviderOrder | GiftCardError>
  getOrder(
    ref: GiftCardProviderOrderRef,
    opts?: {
      /**
       * Retry transient failures (network, 5xx) before giving up. Default
       * true. Callers with their own retry loop pass false so one poll is
       * one vendor call.
       */
      retry?: boolean
    },
  ): Promise<GiftCardProviderOrderStatus | GiftCardError>
}

type GiftCardOrderStatus =
  (typeof import("./index").GiftCardOrderStatus)[keyof typeof import("./index").GiftCardOrderStatus]

type GiftCardOrderStatusHistoryEntry = {
  readonly status: GiftCardOrderStatus
  readonly at: Date
  readonly reason: string | null
}

type GiftCardProductSnapshot = {
  readonly name: string
  readonly brand: string
  readonly countryCode: string
  readonly currency: string
  readonly isOpenLoop: boolean
  readonly logoUrl: string | null
}

type GiftCardOrder = {
  readonly id: GiftCardOrderId
  readonly accountId: AccountId
  readonly walletId: WalletId
  readonly walletCurrency: WalletCurrency
  readonly providerId: GiftCardProviderId
  readonly providerProductId: string
  readonly providerOrderId: GiftCardProviderOrderId | null
  readonly productSnapshot: GiftCardProductSnapshot
  readonly valueMinor: number
  readonly currency: string
  readonly quantity: number
  readonly quoteSats: Satoshis
  readonly invoiceSats: Satoshis | null
  readonly paidSats: Satoshis | null
  readonly paymentRequest: string | null
  readonly paymentHash: string | null
  /** IBEX transaction id from the pay response (`transaction.id`); the reconcile worker re-queries it. */
  readonly providerPaymentRef: string | null
  readonly idempotencyKey: string
  readonly status: GiftCardOrderStatus
  readonly statusHistory: readonly GiftCardOrderStatusHistoryEntry[]
  readonly claimCiphertext: string | null
  readonly claimKeyId: string | null
  readonly fulfilledAt: Date | null
  readonly failureReason: string | null
  readonly expiresAt: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

type GiftCardLimitsMode = "off" | "log-only" | "enforce"
