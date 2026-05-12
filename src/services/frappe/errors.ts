import { DomainError } from "@domain/shared"

export class ErpNextError extends DomainError {}
export class CashoutDraftError extends ErpNextError {}
export class CashoutSubmitError extends ErpNextError {}
export class JournalEntryDeleteError extends ErpNextError {}
export class UpgradeRequestCreateError extends ErpNextError {}
export class UpgradeRequestQueryError extends ErpNextError {}
export class SetDocTypeValueError extends ErpNextError {}
export class BanksQueryError extends ErpNextError {}
export class BankAccountQueryError extends ErpNextError {}
