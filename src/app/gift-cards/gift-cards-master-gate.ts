import { GiftCardsConfig } from "@config"

import { resolvePhoneCountries } from "@app/bridge/kyc-gate"
import {
  GiftCardProviderUnavailableError,
  GiftCardsDisabledError,
  normalizeCountryCode,
} from "@domain/gift-cards"
import { resolveGiftCardProviderIdForCountry } from "@services/gift-cards/registry"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { addAttributesToCurrentSpan } from "@services/tracing"

/**
 * The deploy-level gate every gift-card surface must apply, in ONE place
 * (pattern: `fygaroCheckoutMasterGate`).
 *
 * Two switches, checked in order so the caller gets the more specific answer:
 * `giftCards.enabled` (the whole rail), then "is there an ENABLED provider
 * routed for this country" (`routing.byCountry[cc] ?? routing.default`, gated
 * on `providers.<id>.enabled`). Both the product listing and the purchase
 * mutation go through this so a catalog can never invite a purchase the
 * mutation then refuses.
 *
 * Hands back the provider id it gated on, so a caller cannot pass the gate for
 * one provider and then order from another.
 */
export type GiftCardsMasterGate =
  | { ok: true; providerId: GiftCardProviderId }
  | { ok: false; error: GiftCardsDisabledError | GiftCardProviderUnavailableError }

/**
 * Sentinel for "country unknown". Not a real ISO code (XX is user-assigned),
 * so it can never collide with a `routing.byCountry` entry and therefore
 * always resolves to `routing.default`.
 */
export const UNKNOWN_COUNTRY_CODE = "XX"

export const giftCardsMasterGate = (countryCode: string): GiftCardsMasterGate => {
  if (!GiftCardsConfig?.enabled) {
    return { ok: false, error: new GiftCardsDisabledError() }
  }

  const cc = normalizeCountryCode(countryCode || UNKNOWN_COUNTRY_CODE)
  const providerId = resolveGiftCardProviderIdForCountry(cc)
  if (providerId instanceof Error) return { ok: false, error: providerId }

  return { ok: true, providerId }
}

/**
 * The account's country for provider routing, or null when nothing reliable is
 * on file.
 *
 * WHAT FLASH STORES (surveyed 2026-09-10):
 *
 *  - `Account` has no country field at all (src/domain/accounts/index.types.d.ts).
 *  - Bridge KYC: `Account.bridgeCustomerId` / `bridgeKycStatus` exist, but the
 *    Bridge `Customer` response type (src/services/bridge/client.ts) carries no
 *    address or country, and `snapshotBridgeCustomer` deliberately keeps only
 *    id/status/updated_at/endorsements. A residential address is SENT to Bridge
 *    on customer creation and never read back. So there is no Bridge-sourced
 *    country to prefer; the "Bridge KYC country" tier of the precedence is
 *    empty until the client grows an address read.
 *  - Phone: `User.phoneMetadata.countryCode` (Twilio Lookup at signup) and the
 *    E.164 number itself. `resolvePhoneCountries` (the Bridge KYC gate's own
 *    resolver) already reconciles the two — it trusts the Lookup stamp only
 *    while the number on file cannot contradict it, and falls back to the set
 *    of regions a calling code could denote when libphonenumber cannot name one
 *    (~340 NANP area codes are missing from the pinned metadata).
 *
 * So the effective precedence is: phone country (single, unambiguous
 * candidate) → null. An ambiguous calling-code set (e.g. the 25 NANP regions)
 * is reported as null rather than guessing: for routing, "unknown" goes to
 * `routing.default`, which is the right answer for a country we cannot name.
 *
 * Never throws and never blocks a purchase: a lookup failure is logged and
 * resolves to null, which the caller maps to `UNKNOWN_COUNTRY_CODE`.
 */
export const resolveAccountCountryCode = async (
  account: Pick<Account, "id" | "kratosUserId">,
): Promise<string | null> => {
  try {
    const user = await UsersRepository().findById(account.kratosUserId)
    if (user instanceof Error) {
      baseLogger.warn(
        { accountId: account.id, error: user.constructor.name },
        "Could not load user to resolve gift card routing country; using default",
      )
      return null
    }

    const resolution = resolvePhoneCountries(user)
    addAttributesToCurrentSpan({
      "giftcard.country.source": resolution.source,
      "giftcard.country.candidates": resolution.countries.length,
    })
    if (resolution.countries.length === 1) return resolution.countries[0]
    return null
  } catch (error) {
    baseLogger.warn(
      { accountId: account.id, error },
      "Failed resolving gift card routing country; using default",
    )
    return null
  }
}

/** `resolveAccountCountryCode`, with the null already mapped to the routing sentinel. */
export const resolveAccountCountryCodeOrUnknown = async (
  account: Pick<Account, "id" | "kratosUserId">,
): Promise<string> => (await resolveAccountCountryCode(account)) ?? UNKNOWN_COUNTRY_CODE
