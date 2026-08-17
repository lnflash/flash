import { DomainError, ErrorLevel } from "@domain/shared"

export class FygaroError extends DomainError {
  readonly level: ErrorLevel = ErrorLevel.Warn
}

export class FygaroCheckoutDisabledError extends FygaroError {
  constructor(message: string = "Card top-up is currently unavailable") {
    super(message)
  }
}

export class FygaroBelowMinimumError extends FygaroError {}

export class FygaroAboveSinglePaymentLimitError extends FygaroError {}

export class FygaroDailyAllowanceExceededError extends FygaroError {}

/**
 * We could not establish what the customer is allowed to spend — the settings
 * row or the 24h history was unreadable.
 *
 * Deliberately distinct from "you have hit your limit": the customer has done
 * nothing wrong, and the client should say so rather than accusing them of
 * exceeding an allowance we never actually measured.
 */
export class FygaroAllowanceUnavailableError extends FygaroError {
  constructor(message: string = "Could not check your top-up allowance right now") {
    super(message)
  }
}
