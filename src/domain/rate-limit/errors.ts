import { DomainError, ErrorLevel } from "@domain/shared"

export class RateLimitError extends DomainError {}

export class RateLimitServiceError extends RateLimitError {}
export class UnknownRateLimitServiceError extends RateLimitServiceError {
  level = ErrorLevel.Critical
}

export class RateLimiterExceededError extends RateLimitServiceError {}
export class UserCodeAttemptIdentifierRateLimiterExceededError extends RateLimiterExceededError {}
export class UserCodeAttemptIpRateLimiterExceededError extends RateLimiterExceededError {}
export class UserCodeAttemptBlockedCountryIpRateLimiterExceededError extends RateLimiterExceededError {}
export class CreateDeviceAccountIpRateLimiterExceededError extends RateLimiterExceededError {}
export class ConsentLogIpRateLimiterExceededError extends RateLimiterExceededError {}
export class UserLoginIpRateLimiterExceededError extends RateLimiterExceededError {}
export class UserLoginIdentifierRateLimiterExceededError extends RateLimiterExceededError {}
export class InvoiceCreateRateLimiterExceededError extends RateLimiterExceededError {}
export class InvoiceCreateForRecipientRateLimiterExceededError extends RateLimiterExceededError {}
export class OnChainAddressCreateRateLimiterExceededError extends RateLimiterExceededError {}
export class InviteCreateRateLimiterExceededError extends RateLimiterExceededError {}
export class InviteTargetRateLimiterExceededError extends RateLimiterExceededError {}
export class FygaroCheckoutCreateRateLimiterExceededError extends RateLimiterExceededError {}
export class FygaroTopupAllowanceRateLimiterExceededError extends RateLimiterExceededError {}
// ENG-573: per-account budget on payment-send *attempts* (every call to a send
// mutation, including ones the send guard rejects), so a probe that walks the
// amount space burns its own budget instead of IBEX's.
export class PaymentSendRateLimiterExceededError extends RateLimiterExceededError {}
