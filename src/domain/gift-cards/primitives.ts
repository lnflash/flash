import { GiftCardInvalidValueError, GiftCardProductNotFoundError } from "./errors"

export const GIFT_CARD_PROVIDER_IDS: readonly GiftCardProviderId[] = [
  "bitcoinCompany",
  "bitrefill",
]

/** Flash-wide ceiling on cards per order, whatever the vendor allows. */
export const GIFT_CARD_MAX_QUANTITY = 10

export const isGiftCardProviderId = (value: string): value is GiftCardProviderId =>
  (GIFT_CARD_PROVIDER_IDS as readonly string[]).includes(value)

export const toGiftCardOrderId = (id: string): GiftCardOrderId => id as GiftCardOrderId

export const toGiftCardProviderOrderId = (id: string): GiftCardProviderOrderId =>
  id as GiftCardProviderOrderId

export const buildGiftCardProductId = (
  providerId: GiftCardProviderId,
  providerProductId: string,
): GiftCardProductId => `${providerId}:${providerProductId}` as GiftCardProductId

/** Parses `<providerId>:<providerProductId>`. Vendor ids may themselves contain ":". */
export const parseGiftCardProductId = (
  raw: string,
):
  | { providerId: GiftCardProviderId; providerProductId: string }
  | GiftCardProductNotFoundError => {
  const idx = raw.indexOf(":")
  if (idx <= 0 || idx === raw.length - 1) {
    return new GiftCardProductNotFoundError(`Malformed gift card product id`)
  }
  const providerId = raw.slice(0, idx)
  if (!isGiftCardProviderId(providerId)) {
    return new GiftCardProductNotFoundError(`Unknown gift card provider`)
  }
  return { providerId, providerProductId: raw.slice(idx + 1) }
}

export const normalizeCountryCode = (raw: string): string => raw.trim().toUpperCase()

/**
 * Opaque catalog cursor: base64 of the product id. One codec, used by both the
 * list use case (`endCursor` / `after`) and the GraphQL connection (per-edge
 * cursors), so a cursor copied off any edge resumes in the right place.
 */
export const encodeGiftCardProductCursor = (productId: GiftCardProductId): string =>
  Buffer.from(productId, "utf8").toString("base64")

export const decodeGiftCardProductCursor = (cursor: string): string =>
  Buffer.from(cursor, "base64").toString("utf8")

/**
 * Validates a requested face value (minor units) against the product's
 * denomination rules. Integers only; whole-unit-only cards refuse cents; fixed
 * products must match exactly; variable products must sit inside [min, max].
 */
export const checkedGiftCardValue = (
  product: Pick<
    GiftCardProduct,
    "denominationType" | "denominations" | "minValue" | "maxValue" | "wholeUnitsOnly"
  >,
  valueMinor: number,
): number | GiftCardInvalidValueError => {
  if (!Number.isSafeInteger(valueMinor) || valueMinor <= 0) {
    return new GiftCardInvalidValueError(
      "Gift card value must be a positive whole amount",
    )
  }
  if (product.wholeUnitsOnly && valueMinor % 100 !== 0) {
    return new GiftCardInvalidValueError("This card only accepts whole-unit amounts")
  }
  if (product.denominationType === "fixed") {
    return product.denominations.includes(valueMinor)
      ? valueMinor
      : new GiftCardInvalidValueError(
          "Gift card value must be one of the listed denominations",
        )
  }
  if (product.minValue !== null && valueMinor < product.minValue) {
    return new GiftCardInvalidValueError(
      "Gift card value is below the minimum for this card",
    )
  }
  if (product.maxValue !== null && valueMinor > product.maxValue) {
    return new GiftCardInvalidValueError(
      "Gift card value is above the maximum for this card",
    )
  }
  return valueMinor
}

/**
 * Validates the number of cards. The effective cap is the lower of the
 * product's vendor-stated `maxQuantity` and Flash's own ceiling; a malformed
 * vendor cap (non-integer, below 1) is treated as single-card rather than
 * trusted.
 */
export const checkedGiftCardQuantity = (
  quantity: number,
  maxQuantity: number,
): number | GiftCardInvalidValueError => {
  const vendorCap =
    Number.isSafeInteger(maxQuantity) && maxQuantity >= 1 ? maxQuantity : 1
  const cap = Math.min(vendorCap, GIFT_CARD_MAX_QUANTITY)
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > cap) {
    return new GiftCardInvalidValueError(
      cap === 1
        ? "This card can only be bought one at a time"
        : `Quantity must be between 1 and ${cap}`,
    )
  }
  return quantity
}
