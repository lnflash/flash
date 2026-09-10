import { GiftCardsConfig } from "@config"

import {
  GiftCardProviderUnavailableError,
  normalizeCountryCode,
} from "@domain/gift-cards"

/**
 * Provider registry. Adapters call `registerGiftCardProvider` at module load
 * (from `src/services/gift-cards/index.ts`), so adding a vendor is one import
 * line plus config. Routing is config-driven: `routing.byCountry[cc]`, else
 * `routing.default`; a provider is eligible only when `providers.<id>.enabled`.
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

export const isGiftCardProviderEnabled = (id: GiftCardProviderId): boolean =>
  GiftCardsConfig.enabled === true && GiftCardsConfig.providers[id]?.enabled === true

/** Registered AND enabled providers, for the catalog sync job. */
export const enabledGiftCardProviders = (): IGiftCardProvider[] =>
  [...providers.values()].filter((p) => isGiftCardProviderEnabled(p.id))

export const resolveGiftCardProviderIdForCountry = (
  countryCode: string,
): GiftCardProviderId | GiftCardProviderUnavailableError => {
  const cc = normalizeCountryCode(countryCode)
  const routed = GiftCardsConfig.routing.byCountry[cc] ?? GiftCardsConfig.routing.default
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

/** Enabled provider by id, for orders that already know their provider. */
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
