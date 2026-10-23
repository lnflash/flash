import { DomainError, ErrorLevel } from "@domain/shared"

export class IpFetcherError extends DomainError {}

export class IpFetcherServiceError extends IpFetcherError {}
export class UnknownIpFetcherServiceError extends IpFetcherServiceError {
  level = ErrorLevel.Critical
}
