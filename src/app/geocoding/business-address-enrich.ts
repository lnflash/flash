import GooglePlacesService from "@services/google-places"
import { RedisCacheService } from "@services/cache"
import {
  AddressNotFoundError,
  GeocodingError,
  InvalidAddressInputError,
} from "@domain/google-places/errors"

const CACHE_TTL_SECONDS = 604800 as Seconds // 7 days

/**
 * Enriches a business address using Google Places Geocoding API
 *
 * Validates input, queries Google Places API, and caches results for 7 days
 * to minimize API costs.
 *
 * @param address - The raw address string to enrich
 * @returns GeocodeResult with formatted address and coordinates, or an error
 */
export const businessAddressEnrich = async (
  address: string,
): Promise<AddressEnrichmentResult> => {
  // Input validation
  if (!address || address.trim().length < 3) {
    return new InvalidAddressInputError("Address must be at least 3 characters")
  }

  const normalizedAddress = address.toLowerCase().trim()
  const cacheKey = `geocoding:${normalizedAddress}`

  // Try to get from cache first
  const cache = RedisCacheService()
  const cached = await cache.getOrSet<GeocodeResult, () => Promise<GeocodeResult | ApplicationError>>({
    key: cacheKey,
    ttlSecs: CACHE_TTL_SECONDS,
    getForCaching: async () => {
      const result = await GooglePlacesService.geocodeAddress(address)

      // Map service errors to domain errors
      if (result instanceof Error) {
        switch (result.name) {
          case "AddressNotFoundError":
            return new AddressNotFoundError(result.message)
          case "GeocodingError":
            return new GeocodingError(result.message)
          case "InvalidAddressInputError":
            return new InvalidAddressInputError(result.message)
          default:
            return new GeocodingError("Unknown error while enriching address")
        }
      }

      return result
    },
  })

  return cached
}
