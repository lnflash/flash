import { DomainError } from "@domain/shared"

export class GooglePlacesError extends DomainError {}

export class AddressNotFoundError extends GooglePlacesError {}

export class GeocodingError extends GooglePlacesError {}

export class InvalidAddressInputError extends GooglePlacesError {}
