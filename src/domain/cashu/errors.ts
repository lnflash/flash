import { DomainError, ErrorLevel } from "@domain/shared"

export class CashuMintError extends DomainError {
  level = ErrorLevel.Critical
}

export class CashuMintQuoteNotPaidError extends DomainError {
  level = ErrorLevel.Warn
}

export class CashuMintQuoteExpiredError extends DomainError {
  level = ErrorLevel.Warn
}

export class CashuInvalidCardPubkeyError extends DomainError {
  level = ErrorLevel.Warn
}

export class CashuBlindingError extends DomainError {
  level = ErrorLevel.Critical
}

export class CashuInvalidProofError extends DomainError {
  level = ErrorLevel.Warn
}

export class CashuInsufficientBalanceError extends DomainError {
  level = ErrorLevel.Warn
}
