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

export class BridgeKycOffboardedError extends BridgeError {
  constructor(
    message: string = "Your account has been offboarded from Bridge. Please contact support.",
  ) {
    super(message)
  }
}

export class BridgeInsufficientFundsError extends BridgeError {
  constructor(message: string = "Insufficient funds for withdrawal") {
    super(message)
  }
}

export class BridgeWithdrawalNetAmountTooLowError extends BridgeError {
  constructor(message: string = "Withdrawal amount must exceed estimated customer fees") {
    super(message)
  }
}

export class BridgeAccountLevelError extends BridgeError {
  constructor(
    message: string = "Bridge requires at least a Personal account (Level 1+)",
  ) {
    super(message)
  }
}

export class BridgeBelowMinimumWithdrawalError extends BridgeError {
  constructor(minimum: number) {
    super(`Withdrawal amount is below the minimum of ${minimum} USDT`)
  }
}

export class BridgeInvalidAmountError extends BridgeError {
  constructor(
    message: string = "Amount must be strictly positive with at most 6 decimal places",
  ) {
    super(message)
  }
}

export class BridgeDisabledError extends BridgeError {
  constructor(message: string = "Bridge integration is currently disabled") {
    super(message)
  }
}

export class BridgeTransferFailedError extends BridgeError {
  constructor(reason: string = "Transfer failed") {
    super(reason)
  }
}

export class BridgeDepositInstructionsMissingError extends BridgeError {
  constructor(
    message: string = "Bridge did not return crypto deposit instructions for this withdrawal",
  ) {
    super(message)
  }
}

export class BridgeWebhookValidationError extends BridgeError {
  constructor(message: string = "Invalid webhook signature") {
    super(message)
  }
}

export class BridgeKycTierCeilingExceededError extends BridgeError {
  constructor(message: string = "Withdrawal amount exceeds the KYC tier ceiling") {
    super(message)
  }
}

export class BridgeWithdrawalNotFoundError extends BridgeError {
  constructor(message: string = "Withdrawal request not found") {
    super(message)
  }
}

export class BridgeWithdrawalAlreadyInitiatedError extends BridgeError {
  constructor(
    message: string = "Withdrawal has already been submitted to Bridge and cannot be cancelled",
  ) {
    super(message)
  }
}

export class BridgePlaidNotAvailableError extends BridgeError {
  constructor(
    message: string = "Bank account linking via Plaid is not available. Please enter your bank details manually.",
  ) {
    super(message)
  }
}

/**
 * Maps HTTP status codes from Bridge API to domain error types
 *
 * Checks the response body for specific Bridge error types when applicable.
 */
export const mapBridgeHttpError = (
  statusCode: number,
  response?: unknown,
): BridgeError => {
  // Bridge returns 422/400 with a specific error type for KYC tier ceiling violations.
  if (
    (statusCode === 422 || statusCode === 400) &&
    typeof response === "object" &&
    response !== null
  ) {
    const resp = response as Record<string, unknown>
    const errorObj = (resp.error ?? resp) as Record<string, unknown> | undefined
    const errorType = String(errorObj?.type ?? "").toLowerCase()
    const errorMessage = String(errorObj?.message ?? resp?.message ?? "").toLowerCase()

    if (
      errorType.includes("kyc_tier_limit") ||
      errorType.includes("kyc_limit") ||
      errorType.includes("tier_ceiling") ||
      (errorMessage.includes("kyc") &&
        (errorMessage.includes("limit") ||
          errorMessage.includes("ceiling") ||
          errorMessage.includes("tier")))
    ) {
      const message =
        typeof errorObj?.message === "string"
          ? errorObj.message
          : typeof resp.message === "string"
            ? resp.message
            : undefined
      return new BridgeKycTierCeilingExceededError(message)
    }
  }

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
