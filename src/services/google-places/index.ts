import axios from "axios"
import { GooglePlacesConfig } from "@config"
import { baseLogger } from "@services/logger"
import {
  AddressNotFoundError,
  GeocodingError,
  InvalidAddressInputError,
} from "./errors"

type GeocodeResult = {
  formattedAddress: string
  latitude: number
  longitude: number
}

type GoogleGeocodeResponse = {
  status: string
  results: Array<{
    formatted_address: string
    geometry: {
      location: {
        lat: number
        lng: number
      }
    }
  }>
  error_message?: string
}

class GooglePlacesService {
  private readonly apiKey: string | undefined
  private readonly baseUrl = "https://maps.googleapis.com/maps/api/geocode/json"

  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey
  }

  async geocodeAddress(address: string): Promise<GeocodeResult | GooglePlacesError> {
    // Validate API key is configured
    if (!this.apiKey || this.apiKey === "<replace>") {
      baseLogger.error("GOOGLE_PLACES_API_KEY not configured")
      return new GeocodingError("Google Places API key not configured")
    }

    // Validate input
    if (!address || address.trim().length < 3) {
      return new InvalidAddressInputError("Address must be at least 3 characters")
    }

    try {
      const url = `${this.baseUrl}?address=${encodeURIComponent(address)}&key=${this.apiKey}`

      const response = await axios.get<GoogleGeocodeResponse>(url)
      const data = response.data

      // Handle Google API error statuses
      if (data.status === "ZERO_RESULTS") {
        return new AddressNotFoundError("No results found for this address")
      }

      if (data.status !== "OK") {
        baseLogger.error(
          { status: data.status, errorMessage: data.error_message },
          "Google Places API error",
        )
        return new GeocodingError(
          `Failed to validate address: ${data.error_message || data.status}`,
        )
      }

      // Extract result
      const result = data.results[0]
      return {
        formattedAddress: result.formatted_address,
        latitude: result.geometry.location.lat,
        longitude: result.geometry.location.lng,
      }
    } catch (err) {
      baseLogger.error({ err, address }, "Error calling Google Places API")
      return new GeocodingError("Internal server error while enriching address")
    }
  }
}

export default new GooglePlacesService(GooglePlacesConfig.apiKey)
