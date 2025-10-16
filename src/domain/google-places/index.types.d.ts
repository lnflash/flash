type GooglePlacesError = import("./errors").GooglePlacesError

type GeocodeResult = {
  formattedAddress: string
  latitude: number
  longitude: number
}

type AddressEnrichmentResult = GeocodeResult | ApplicationError
