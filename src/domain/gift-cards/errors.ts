import { DomainError, ErrorLevel } from "@domain/shared"

/**
 * Gift card errors. All names carry the `GiftCard` prefix because
 * `ApplicationErrors` spreads every error module into one namespace and
 * `error-map.ts` switches on the constructor name — a collision there is a
 * silent mis-mapping, not a compile error.
 */
export class GiftCardError extends DomainError {
  readonly level: ErrorLevel = ErrorLevel.Warn
}

/** Feature master gate is off, or the provider for this country is disabled. */
export class GiftCardsDisabledError extends GiftCardError {
  constructor(message: string = "Gift cards are currently unavailable") {
    super(message)
  }
}

/** No enabled provider serves the account's country. Deterministic until config changes. */
export class GiftCardProviderUnavailableError extends GiftCardError {
  constructor(message: string = "Gift cards are not available in your region yet") {
    super(message)
  }
}

export class GiftCardProductNotFoundError extends GiftCardError {}

export class GiftCardProductNotAvailableInCountryError extends GiftCardError {}

/** Value is not one of the fixed denominations, or is outside min..max. */
export class GiftCardInvalidValueError extends GiftCardError {}

/** A Flash-imposed or vendor-imposed cap would be exceeded (enforce mode only). */
export class GiftCardLimitExceededError extends GiftCardError {}

/**
 * The account level has no gift card allowance. Deliberately distinct from
 * "unavailable": permanent until the account upgrades, so the client can route
 * to the upgrade flow instead of asking the user to retry.
 */
export class GiftCardLevelNotEligibleError extends GiftCardError {
  constructor(message: string = "Gift cards aren't available on your account level yet") {
    super(message)
  }
}

/** The vendor invoice amount drifted beyond tolerance from the quote we showed. No payment was made. */
export class GiftCardQuoteMismatchError extends GiftCardError {}

export class GiftCardOrderNotFoundError extends GiftCardError {}

/** A state transition was attempted from a state that does not allow it. */
export class GiftCardOrderStateError extends GiftCardError {}

/** Vendor returned a definitive rejection when creating the order. No payment was made. */
export class GiftCardVendorRejectedOrderError extends GiftCardError {}

/** Vendor unreachable, 5xx, or returned a shape we refuse to interpret. */
export class GiftCardVendorUnavailableError extends GiftCardError {
  readonly level: ErrorLevel = ErrorLevel.Critical
  constructor(message: string = "Gift card provider is temporarily unavailable") {
    super(message)
  }
}

/** Catalog cache is missing or older than the hard staleness limit. */
export class GiftCardCatalogUnavailableError extends GiftCardError {
  constructor(message: string = "Gift card catalog is temporarily unavailable") {
    super(message)
  }
}

/** Claim-data encryption/decryption failed (bad key, corrupt ciphertext). Never expose details. */
export class GiftCardClaimCryptoError extends GiftCardError {
  readonly level: ErrorLevel = ErrorLevel.Critical
  constructor(message: string = "Could not read gift card details") {
    super(message)
  }
}

/** The idempotency key was reused with different purchase parameters. */
export class GiftCardIdempotencyKeyReuseError extends GiftCardError {}

export class UnknownGiftCardError extends GiftCardError {
  readonly level: ErrorLevel = ErrorLevel.Critical
}
