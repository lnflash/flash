import { DomainError, ErrorLevel } from "@domain/shared"

export class BridgeError extends DomainError {
  readonly level: ErrorLevel = ErrorLevel.Warn
}

export class BridgeApiError extends BridgeError {
  readonly statusCode: number
  readonly response?: unknown

  constructor(message: string, statusCode: number, response?: unknown) {
    super(message)
    this.statusCode = statusCode
    this.response = response
  }
}

export class BridgeRateLimitError extends BridgeError {
  constructor(message: string = "Rate limit exceeded, please try again later") {
    super(message)
  }
}

export class BridgeTimeoutError extends BridgeError {
  constructor(message: string = "Request timed out") {
    super(message)
  }
}

export class BridgeCustomerNotFoundError extends BridgeError {
  constructor(message: string = "Bridge customer not found") {
    super(message)
  }
}

export class BridgeKycPendingError extends BridgeError {
  constructor(message: string = "KYC verification is pending") {
    super(message)
  }
}

export class BridgeKycRejectedError extends BridgeError {
  constructor(message: string = "KYC verification was rejected") {
    super(message)
  }
}

export class BridgeInsufficientFundsError extends BridgeError {
  constructor(message: string = "Insufficient funds for withdrawal") {
    super(message)
  }
}

export class BridgeAccountLevelError extends BridgeError {
  constructor(message: string = "Bridge requires Pro account (Level 2+)") {
    super(message)
  }
}

export class BridgeDisabledError extends BridgeError {
  constructor(message: string = "Bridge integration is currently disabled") {
    super(message)
  }
}

export class BridgeWebhookValidationError extends BridgeError {
  constructor(message: string = "Invalid webhook signature") {
    super(message)
  }
}

/**
 * Maps HTTP status codes from Bridge API to domain error types
 */
export const mapBridgeHttpError = (
  statusCode: number,
  response?: unknown,
): BridgeError => {
  switch (statusCode) {
    case 404:
      return new BridgeCustomerNotFoundError()
    case 429:
      return new BridgeRateLimitError()
    case 408:
      return new BridgeTimeoutError()
    default:
      return new BridgeApiError("Bridge API error", statusCode, response)
  }
}
