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

export type ProductMappingSkipReason =
  "no-country" | "unknown-denomination-type" | "no-denominations"

export type ProductMappingSkip = { readonly skipped: ProductMappingSkipReason }

export const isProductMappingSkip = (
  value: GiftCardProduct | ProductMappingSkip,
): value is ProductMappingSkip => "skipped" in value

const toMinorDenominations = (major: readonly number[]): number[] =>
  [
    ...new Set(major.map(toMinorUnits).filter((d) => Number.isSafeInteger(d) && d > 0)),
  ].sort((a, b) => a - b)

export const mapVendorProduct = (
  product: VendorProduct,
): GiftCardProduct | ProductMappingSkip => {
  const rawCountry = product.countries.find((c) => c.trim().length > 0)
  if (!rawCountry) return { skipped: "no-country" }

  const denominationType = mapDenominationType(product.denominationType)
  if (!denominationType) return { skipped: "unknown-denomination-type" }

  const denominations = toMinorDenominations(product.denominations)
  if (denominations.length === 0) return { skipped: "no-denominations" }

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
  bitcoinPriceMinor: toMinorUnits(vendor.bitcoinPrice),
  expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
})

/**
 * The vendor's purchase response carries no order expiry; the only expiry is
 * the one encoded in the BOLT11 itself, which `purchaseGiftCard` decodes. Not
 * invented here: a fabricated "now + 15 min" would silently outlive a shorter
 * invoice and keep an unpayable order open.
 */
export const mapVendorPurchase = (vendor: VendorPurchase): GiftCardProviderOrder => ({
  providerOrderId: toGiftCardProviderOrderId(String(vendor.uuid)),
  paymentRequest: vendor.invoice,
  amountSats: toSats(Math.round(vendor.amount)),
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

type VendorStatusBucket = GiftCardProviderOrderStatus["kind"]

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
  disputed: "refunded",
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
