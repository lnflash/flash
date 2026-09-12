import { GiftCardsConfig } from "@config"

import {
  GiftCardProviderUnavailableError,
  normalizeCountryCode,
} from "@domain/gift-cards"

/**
 * Provider registry. Adapters call `registerGiftCardProvider` at module load
 * (from `src/services/gift-cards/index.ts`), so adding a vendor is one import
 * line plus config. Routing is config-driven: `routing.byCountry[cc]`, else
 * `routing.default`; a provider is eligible only when `providers.<id>.enabled`
 * AND an adapter is registered under the id. Config alone is not enough: an
 * enabled-but-unregistered id would advertise gift cards (the globals flag,
 * the country gate) while every read and write failed.
 *
 * Config is read at call time, not module load, so tests can mock `@config`.
 */
const providers = new Map<GiftCardProviderId, IGiftCardProvider>()

export const registerGiftCardProvider = (provider: IGiftCardProvider): void => {
  providers.set(provider.id, provider)
}

export const getRegisteredGiftCardProvider = (
  id: GiftCardProviderId,
): IGiftCardProvider | undefined => providers.get(id)

/**
 * Registered provider by id, regardless of `enabled`. For orders that already
 * exist: settlement and reconciliation must keep working after the kill switch
 * flips, otherwise a customer who has already paid never receives their code
 * and the 24h REFUND_REQUIRED alert goes quiet. New money (quote / purchase)
 * goes through `getEnabledGiftCardProvider`, never this.
 */
export const getRegisteredGiftCardProviderOrError = (
  id: GiftCardProviderId,
): IGiftCardProvider | GiftCardProviderUnavailableError => {
  const provider = providers.get(id)
  if (!provider) return new GiftCardProviderUnavailableError()
  return provider
}

/** Master switch on, provider switch on, and an adapter registered under the id. */
export const isGiftCardProviderEnabled = (id: GiftCardProviderId): boolean =>
  GiftCardsConfig.enabled === true &&
  GiftCardsConfig.providers[id]?.enabled === true &&
  providers.has(id)

/** Registered AND enabled providers, for the catalog sync job. */
export const enabledGiftCardProviders = (): IGiftCardProvider[] =>
  [...providers.values()].filter((p) => isGiftCardProviderEnabled(p.id))

// Country keys are compared normalised on both sides so `{ jm: bitrefill }` in
// the yaml routes the same as `{ JM: bitrefill }`.
const routedProviderId = (cc: string): GiftCardProviderId => {
  for (const [key, id] of Object.entries(GiftCardsConfig.routing.byCountry)) {
    if (normalizeCountryCode(key) === cc) return id
  }
  return GiftCardsConfig.routing.default
}

export const resolveGiftCardProviderIdForCountry = (
  countryCode: string,
): GiftCardProviderId | GiftCardProviderUnavailableError => {
  const routed = routedProviderId(normalizeCountryCode(countryCode))
  if (!isGiftCardProviderEnabled(routed)) return new GiftCardProviderUnavailableError()
  return routed
}

export const getGiftCardProviderForCountry = (
  countryCode: string,
): IGiftCardProvider | GiftCardProviderUnavailableError => {
  const id = resolveGiftCardProviderIdForCountry(countryCode)
  if (id instanceof Error) return id
  const provider = providers.get(id)
  if (!provider) return new GiftCardProviderUnavailableError()
  return provider
}

/**
 * Enabled provider by id. For quote and purchase only — the paths that create
 * new orders and move new money. An order that already exists settles through
 * `getRegisteredGiftCardProviderOrError`, so the kill switch never strands it.
 */
export const getEnabledGiftCardProvider = (
  id: GiftCardProviderId,
): IGiftCardProvider | GiftCardProviderUnavailableError => {
  if (!isGiftCardProviderEnabled(id)) return new GiftCardProviderUnavailableError()
  const provider = providers.get(id)
  if (!provider) return new GiftCardProviderUnavailableError()
  return provider
}

export const __resetGiftCardProvidersForTest = (): void => {
  providers.clear()
}
