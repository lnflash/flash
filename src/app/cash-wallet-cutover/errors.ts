import { DomainError, ValidationError } from "@domain/shared"

export class InvalidCashWalletCutoverAmountError extends ValidationError {}
export class InvalidCashWalletMigrationTransitionError extends ValidationError {}
export class CashWalletCutoverInProgressError extends ValidationError {}
export class CashWalletMigrationFailedError extends DomainError {}
export class CashWalletCutoverPreflightError extends DomainError {}
export class CashWalletCutoverTreasuryInsufficientBalanceError extends DomainError {}
