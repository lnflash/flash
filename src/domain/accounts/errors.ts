import { DomainError } from "@domain/shared"

export class AccountError extends DomainError {}

export class UsernameNotAvailableError extends AccountError {}
export class UsernameIsImmutableError extends AccountError {}

export class InvalidAccountError extends AccountError {}
export class InvalidAccountIdError extends AccountError {}
export class InvalidWalletForAccountError extends AccountError {}

// ENG-889: cash-outs are held for this account (Account.cashoutHold). The
// message reaches the account holder, so it never names the reason.
export class AccountCashoutHeldError extends AccountError {
  constructor(
    message: string = "Cash out is unavailable for this account. Please contact support.",
  ) {
    super(message)
  }
}
