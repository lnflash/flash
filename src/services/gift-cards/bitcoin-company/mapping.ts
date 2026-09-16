import { toSats } from "@domain/bitcoin"
import {
  buildGiftCardProductId,
  normalizeCountryCode,
  toGiftCardProviderOrderId,
} from "@domain/gift-cards"

import {
  VendorClaimData,
  VendorProduct,
  VendorPurchase,
  VendorPurchasedProduct,
  VendorQuote,
} from "./schemas"

/**
 * Pure vendor → domain mapping. No I/O, no logging: functions that need to
 * warn return a `warning` string and let the caller decide where it goes.
 */

export const BITCOIN_COMPANY_PROVIDER_ID: GiftCardProviderId = "bitcoinCompany"

export const QUOTE_TTL_MS = 60 * 1000

/**
 * Cards per order this adapter will place. Held at 1 until a sandbox
 * `/giftcards/invoice-status` response for a quantity-2 order has been
 * captured: `purchasedProductSchema` models exactly one `{ status, claimData }`
 * and a per-card array would fail validation on every status poll, stranding a
 * paid order. Raising this is a fixture-plus-schema change, not a config flip.
 */
export const BITCOIN_COMPANY_MAX_QUANTITY = 1

/** The vendor's name for the payment rail we settle over. */
export const LIGHTNING_PAYMENT_TYPE = "Lightning"

/** Vendor money is in major units of the product currency; the domain is minor units. */
export const toMinorUnits = (major: number): number => Math.round(major * 100)
export const toMajorUnits = (minor: number): number => minor / 100

// Two regional-indicator symbols make one flag emoji.
const TRAILING_FLAG = /\s*[\u{1F1E6}-\u{1F1FF}]{2}\s*$/u
// "(US)" / "(USA)". Deliberately narrow so "(Digital)" and similar survive.
const TRAILING_COUNTRY_PAREN = /\s*\([A-Za-z]{2,3}\)\s*$/

/** "Visa 🇺🇸 (US)" → "Visa". Falls back to the trimmed name if stripping would empty it. */
export const stripBrand = (name: string): string => {
  const trimmed = name.trim()
  let out = trimmed
  for (;;) {
    const next = out.replace(TRAILING_FLAG, "").replace(TRAILING_COUNTRY_PAREN, "").trim()
    if (next === out) break
    out = next
  }
  return out.length > 0 ? out : trimmed
}

export const mapDenominationType = (raw: string): GiftCardDenominationType | null => {
  switch (raw) {
    case "Fixed":
      return "fixed"
    case "Variable":
    case "VariableNoCents":
      return "variable"
    default:
      return null
  }
}

/**
 * Why a catalog row was left out. `invalid` (failed schema validation) is
 * counted by the client, which never hands such rows to the mapper; it is
 * listed here so the sync log reports every reason under one key set.
 */
export type ProductMappingSkipReason =
  | "invalid"
  | "noCountry"
  | "physical"
  | "noLightning"
  | "unknownDenominationType"
  | "noDenominations"

export const PRODUCT_MAPPING_SKIP_REASONS: readonly ProductMappingSkipReason[] = [
  "invalid",
  "noCountry",
  "physical",
  "noLightning",
  "unknownDenominationType",
  "noDenominations",
]

export type ProductMappingSkip = { readonly skipped: ProductMappingSkipReason }

export const isProductMappingSkip = (
  value: GiftCardProduct | ProductMappingSkip,
): value is ProductMappingSkip => "skipped" in value

/**
 * `resellingEnabled: false` on a row we nevertheless keep. The public catalog
 * shows false on every product until the account is KYB'd, so skipping would
 * empty the catalog; the adapter counts these and warns instead.
 * TODO(ENG-586): flip to a skip reason once KYB flips resellingEnabled.
 */
export const isResellingDisabled = (product: VendorProduct): boolean =>
  product.resellingEnabled === false

const acceptsLightning = (paymentTypes: readonly string[]): boolean =>
  paymentTypes.some(
    (type) => type.trim().toLowerCase() === LIGHTNING_PAYMENT_TYPE.toLowerCase(),
  )

const toMinorDenominations = (major: readonly number[]): number[] =>
  [
    ...new Set(major.map(toMinorUnits).filter((d) => Number.isSafeInteger(d) && d > 0)),
  ].sort((a, b) => a - b)

export const mapVendorProduct = (
  product: VendorProduct,
): GiftCardProduct | ProductMappingSkip => {
  const rawCountry = product.countries.find((c) => c.trim().length > 0)
  if (!rawCountry) return { skipped: "noCountry" }

  // We deliver codes in-app; a shipped card has nothing to deliver.
  if (product.isPhysical === true) return { skipped: "physical" }

  // Absent means the vendor did not say; present-but-without-Lightning means no.
  if (product.paymentTypes && !acceptsLightning(product.paymentTypes)) {
    return { skipped: "noLightning" }
  }

  const denominationType = mapDenominationType(product.denominationType)
  if (!denominationType) return { skipped: "unknownDenominationType" }

  const denominations = toMinorDenominations(product.denominations)
  if (denominations.length === 0) return { skipped: "noDenominations" }

  const logoUrl = product.logo || product.panelImg || null

  return {
    id: buildGiftCardProductId(BITCOIN_COMPANY_PROVIDER_ID, product.id),
    providerId: BITCOIN_COMPANY_PROVIDER_ID,
    providerProductId: product.id,
    name: product.name.trim(),
    brand: stripBrand(product.name),
    countryCode: normalizeCountryCode(rawCountry),
    currency: product.currency.trim().toUpperCase(),
    denominationType,
    denominations: denominationType === "fixed" ? denominations : [],
    minValue: denominationType === "variable" ? denominations[0] : null,
    maxValue:
      denominationType === "variable" ? denominations[denominations.length - 1] : null,
    isOpenLoop: product.isOpenLoop,
    categories: product.categories ?? [],
    logoUrl,
    // Vendor `terms` is free text, not a URL.
    termsUrl: null,
    rewardBps: Math.round(product.satsBackPercentage * 100),
    inStock: product.stock !== 0,
    maxQuantity: BITCOIN_COMPANY_MAX_QUANTITY,
    // Fixed products: every denomination is already a whole unit and the value
    // must match one exactly, so the extra rule would be redundant.
    wholeUnitsOnly: product.denominationType === "VariableNoCents",
  }
}

export const mapVendorQuote = ({
  product,
  valueMinor,
  quantity,
  vendor,
  now,
}: {
  product: GiftCardProduct
  valueMinor: number
  quantity: number
  vendor: VendorQuote
  now: Date
}): GiftCardQuote => ({
  productId: product.id,
  valueMinor,
  currency: product.currency,
  quantity,
  fiatCostMinor: toMinorUnits(vendor.fiatCost),
  satsCost: toSats(Math.round(vendor.satsCost)),
  rewardSats: toSats(Math.round(vendor.satsBack)),
  bitcoinPriceMinor:
    vendor.bitcoinPrice === null || vendor.bitcoinPrice === undefined
      ? null
      : toMinorUnits(vendor.bitcoinPrice),
  expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
})

/**
 * The vendor's purchase response carries no order expiry; the only expiry is
 * the one encoded in the BOLT11 itself, which `purchaseGiftCard` decodes. Not
 * invented here: a fabricated "now + 15 min" would silently outlive a shorter
 * invoice and keep an unpayable order open.
 *
 * `amountSats` is non-null on the port, so a missing vendor `amount` maps to 0.
 * That is safe because the purchase path decodes the BOLT11 and pays
 * `max(invoiceSats, amountSats)`: the invoice amount governs, the vendor's
 * figure can only ever raise it, never lower it.
 */
export const mapVendorPurchase = (vendor: VendorPurchase): GiftCardProviderOrder => ({
  providerOrderId: toGiftCardProviderOrderId(String(vendor.uuid)),
  paymentRequest: vendor.invoice,
  amountSats: toSats(Math.round(vendor.amount ?? 0)),
  expiresAt: null,
})

/** Returns null when there is nothing a customer could redeem. */
export const mapVendorClaim = (
  claimData: VendorClaimData | null | undefined,
): GiftCardClaim | null => {
  if (!claimData) return null
  const codes: GiftCardClaimCode[] = (claimData.codes ?? [])
    .filter((c) => c.value.trim().length > 0)
    .map((c) => ({ label: c.label ?? null, value: c.value }))
  const claimLink = claimData.claimLink || null
  if (codes.length === 0 && claimLink === null) return null
  const barcode: GiftCardBarcode | null =
    claimData.barcodeChars && claimData.barcodeType
      ? { chars: claimData.barcodeChars, type: claimData.barcodeType }
      : null
  return { codes, claimLink, barcode }
}

/**
 * Port status, plus `held`: a vendor status that is neither settled nor
 * terminal for us (a dispute in flight). Held orders stay
 * `paidPendingFulfillment` with a warning until a later Refunded / ClawedBack /
 * Completed poll, or the 24h REFUND_REQUIRED timeout, decides.
 */
type VendorStatusBucket = GiftCardProviderOrderStatus["kind"] | "held"

// Keys are lower-cased so a casing change on the vendor side does not turn a
// known status into an "unknown" one.
const VENDOR_STATUS_TABLE: Readonly<Record<string, VendorStatusBucket>> = {
  unpaid: "awaitingPayment",
  underpaid: "awaitingPayment",
  confirming: "awaitingPayment",
  pending: "paidPendingFulfillment",
  senttofulfillment: "paidPendingFulfillment",
  completed: "fulfilled",
  sent: "fulfilled",
  claimed: "fulfilled",
  shipped: "fulfilled",
  expired: "failed",
  cancelled: "failed",
  refunded: "refunded",
  // A dispute is not a refund: money may still come back as a card or as a
  // refund, and calling it terminal either way would be a guess.
  disputed: "held",
  clawedback: "refunded",
}

export const KNOWN_VENDOR_STATUSES: readonly string[] = Object.keys(VENDOR_STATUS_TABLE)

/**
 * Vendor status → port status. Never reports `fulfilled` without something the
 * customer can redeem, and never guesses at an unknown status: both fall back
 * to `paidPendingFulfillment` with a warning for the caller to log.
 */
export const mapVendorOrderStatus = (
  vendor: VendorPurchasedProduct,
): { status: GiftCardProviderOrderStatus; warning: string | null } => {
  const vendorStatus = vendor.status.trim()
  const bucket = VENDOR_STATUS_TABLE[vendorStatus.toLowerCase()]

  switch (bucket) {
    case "awaitingPayment":
    case "paidPendingFulfillment":
      return { status: { kind: bucket }, warning: null }
    case "failed":
    case "refunded":
      return { status: { kind: bucket, reason: vendorStatus }, warning: null }
    case "held":
      return {
        status: { kind: "paidPendingFulfillment" },
        warning: `Bitcoin Company reported "${vendorStatus}"; holding as pending until the vendor settles it or the timeout decides`,
      }
    case "fulfilled": {
      const claim = mapVendorClaim(vendor.claimData)
      if (!claim) {
        return {
          status: { kind: "paidPendingFulfillment" },
          warning: `Bitcoin Company reported "${vendorStatus}" without claim data; holding as pending`,
        }
      }
      return { status: { kind: "fulfilled", claim }, warning: null }
    }
    default:
      return {
        status: { kind: "paidPendingFulfillment" },
        warning: `Bitcoin Company returned unknown order status "${vendorStatus}"; holding as pending`,
      }
  }
}
