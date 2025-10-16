export class GooglePlacesError extends Error {
  name = "GooglePlacesError"
}

export class AddressNotFoundError extends GooglePlacesError {
  name = "AddressNotFoundError"
}

export class GeocodingError extends GooglePlacesError {
  name = "GeocodingError"
}

export class InvalidAddressInputError extends GooglePlacesError {
  name = "InvalidAddressInputError"
}
