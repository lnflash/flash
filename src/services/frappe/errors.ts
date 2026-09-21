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
export class BankAccountUpdateRequestCreateError extends ErpNextError {}
export class BankAccountUpdateRequestQueryError extends ErpNextError {}
export class BankAccountCreateError extends ErpNextError {}
export class BankAccountUpdateError extends ErpNextError {}
export class BankAccountDeleteError extends ErpNextError {}
export class BankAccountSetDefaultError extends ErpNextError {}
// ERPNext refused the write on purpose (frappe.throw): the account number is
// already on another Bank Account.
export class BankAccountDuplicateNumberError extends ErpNextError {}
// ERPNext refused the write on purpose: the Bank Account does not exist or does
// not belong to the customer.
export class BankAccountNotOwnedError extends ErpNextError {}
// Any other deliberate ERPNext refusal (bad account type, currency, ...).
export class BankAccountValidationError extends ErpNextError {}
// The account has no ERPNext customer yet, i.e. the upgrade is not complete.
export class BankAccountUpgradeRequiredError extends ErpNextError {}
export class ExchangeRateQueryError extends ErpNextError {}
export class BridgeTransferRequestUpsertError extends ErpNextError {}
export class FygaroSettingsQueryError extends ErpNextError {}
export class ReferralSettingsQueryError extends ErpNextError {}
export class FeeDiscountQueryError extends ErpNextError {}
export class AllowedCountryQueryError extends ErpNextError {}
export class FygaroTopupHistoryQueryError extends ErpNextError {}
export class IdVerificationCreateError extends ErpNextError {}
export class IdVerificationQueryError extends ErpNextError {}
export class IdVerificationUpdateError extends ErpNextError {}
