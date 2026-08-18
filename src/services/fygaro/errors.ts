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
 * The account is HOLDING its allowance in an unpaid checkout link, not spending
 * it.
 *
 * Deliberately NOT `FygaroDailyAllowanceExceededError`: an account that has
 * spent $0 today and abandoned one payment page has not exceeded anything, and
 * telling it "you have $0.00 left of today's top-up limit" is a false statement
 * that also invites the one action — retry now — that keeps hitting it. This
 * says what is true and, in the message, when the hold lifts.
 */
export class FygaroCheckoutAlreadyOpenError extends FygaroError {}

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

/**
 * The account's level has no configured top-up allowance (level 0 today).
 *
 * Deliberately NOT an "unavailable" error: that reason is deterministic and
 * permanent until the account upgrades, so telling the customer to try again
 * later sends them into a loop and sends support chasing a phantom outage. Its
 * own code exists so the client can route them to the upgrade flow instead.
 */
export class FygaroLevelNotEligibleError extends FygaroError {
  constructor(message: string = "Card top-up isn't available on your account level yet") {
    super(message)
  }
}

/**
 * The reservation index could not be written.
 *
 * Distinct from a failed cross-check record: without the reservation the
 * authorisation is invisible to the next request, so the same allowance can be
 * handed out again. The read side already fails closed, and the write side has
 * to match — a link minted with no hold is exactly the over-issue this guards.
 */
export class FygaroReservationWriteError extends FygaroError {}
