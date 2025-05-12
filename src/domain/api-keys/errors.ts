import { ValidationError } from "@domain/shared/errors"
import { ErrorLevel } from "@domain/shared"

// Create a local DomainError for API key errors
export class DomainError extends Error {
  name = this.constructor.name
  level: ErrorLevel = ErrorLevel.Critical
}

export const ApiKeyErrorMessage = {
  ApiKeyNotFound: "API key not found",
  ApiKeyInvalid: "Invalid API key format",
  ApiKeyRevoked: "API key has been revoked",
  ApiKeyExpired: "API key has expired",
  ApiKeyInactive: "API key is inactive",
  InvalidScope: "Invalid scope format",
  ScopeNotAllowed: "Requested scope not allowed for this API key",
  InvalidApiKeyName: "Invalid API key name",
  ApiKeyLimitReached: "Maximum number of API keys reached for this account",
  InvalidExpirationDate: "Invalid expiration date",
  InvalidAccountId: "Invalid account ID",
  RateLimitExceeded: "Rate limit exceeded",
  InvalidSignature: "Invalid webhook signature",
  ApiKeyIdRequired: "API key ID is required",
  ApiKeyCreationFailed: "API key creation failed",
  KeyRotationFailed: "API key rotation failed",
} as const

// API Key Errors
export class ApiKeyError extends DomainError {
  level = ErrorLevel.Critical

  constructor() {
    super()
    this.message = "API Key Error"
  }
}

export class ApiKeyNotFoundError extends ApiKeyError {
  constructor(keyId?: string) {
    super()
    this.message = `${ApiKeyErrorMessage.ApiKeyNotFound}${keyId ? `: ${keyId}` : ""}`
  }
}

export class ApiKeyInvalidError extends ApiKeyError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.ApiKeyInvalid
  }
}

export class ApiKeyRevokedError extends ApiKeyError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.ApiKeyRevoked
  }
}

export class ApiKeyExpiredError extends ApiKeyError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.ApiKeyExpired
  }
}

export class ApiKeyInactiveError extends ApiKeyError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.ApiKeyInactive
  }
}

export class InvalidScopeError extends ValidationError {
  constructor(scope?: string) {
    super()
    this.message = `${ApiKeyErrorMessage.InvalidScope}${scope ? `: ${scope}` : ""}`
  }
}

export class ScopeNotAllowedError extends ApiKeyError {
  constructor(scope: string) {
    super()
    this.message = `${ApiKeyErrorMessage.ScopeNotAllowed}: ${scope}`
  }
}

export class InvalidApiKeyNameError extends ValidationError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.InvalidApiKeyName
  }
}

export class ApiKeyLimitReachedError extends ApiKeyError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.ApiKeyLimitReached
  }
}

export class InvalidExpirationDateError extends ValidationError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.InvalidExpirationDate
  }
}

export class InvalidAccountIdError extends ValidationError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.InvalidAccountId
  }
}

export class RateLimitExceededError extends ApiKeyError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.RateLimitExceeded
  }
}

export class InvalidSignatureError extends ApiKeyError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.InvalidSignature
  }
}

export class ApiKeyIdRequiredError extends ValidationError {
  constructor() {
    super()
    this.message = ApiKeyErrorMessage.ApiKeyIdRequired
  }
}

export class ApiKeyCreationFailedError extends ApiKeyError {
  constructor(details?: string) {
    super()
    this.message = `${ApiKeyErrorMessage.ApiKeyCreationFailed}${details ? `: ${details}` : ""}`
  }
}

export class KeyRotationFailedError extends ApiKeyError {
  constructor(details?: string) {
    super()
    this.message = `${ApiKeyErrorMessage.KeyRotationFailed}${details ? `: ${details}` : ""}`
  }
}