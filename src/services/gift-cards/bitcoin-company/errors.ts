import { DomainError, ErrorLevel } from "@domain/shared"

/**
 * Transport-level errors for the Bitcoin Company client. They never leave the
 * adapter: `client.ts` catches every one of them and maps it to the domain
 * `GiftCard*` error the port returns, so nothing here needs an `error-map.ts`
 * entry and none of these names can collide with `ApplicationErrors`.
 */
export class BitcoinCompanyError extends DomainError {
  readonly level: ErrorLevel = ErrorLevel.Warn
}

/** Non-2xx status, or a 2xx envelope carrying `error` with a null `result`. */
export class BitcoinCompanyApiError extends BitcoinCompanyError {
  constructor(
    message: string,
    readonly status: number,
    readonly vendorError: string | null,
  ) {
    super(message)
  }
}

/** 401 on an authenticated call. Tells the client to refresh and retry once. */
export class BitcoinCompanyUnauthorizedError extends BitcoinCompanyError {}

/** Connection refused/reset, DNS failure, or timeout: no response was received. */
export class BitcoinCompanyNetworkError extends BitcoinCompanyError {}

/** The response did not validate against the schema we expect. */
export class BitcoinCompanyResponseShapeError extends BitcoinCompanyError {
  readonly level: ErrorLevel = ErrorLevel.Critical
}

/** Could not obtain an access token: credentials missing or login rejected. */
export class BitcoinCompanyAuthError extends BitcoinCompanyError {
  readonly level: ErrorLevel = ErrorLevel.Critical
}
