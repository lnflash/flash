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
// The ONLY BankAccountValidationError messages the GraphQL error map will show
// to a customer. Text is written here, never copied from an ERPNext response:
// a frappe.throw can carry HTML, doctype names or a Python import path.
export const BankAccountValidationReason = {
  AccountType: "Account type must be Chequing or Savings.",
  Currency: "Currency must be JMD or USD.",
  BankName: "Bank name is required.",
  AccountNumber: "A valid account number is required.",
  // The number sits on a Bank Account the customer cannot see: another
  // customer's, or one support disabled. Deliberately says nothing about which.
  NumberNotAccepted:
    "This account number cannot be used. Please contact support if it is yours.",
  OwnRemovedNumber:
    "This account number belongs to a bank account you removed. Add it again instead of editing another account.",
} as const

export const isBankAccountValidationReason = (message: string): boolean =>
  (Object.values(BankAccountValidationReason) as string[]).includes(message)

// A deliberate ERPNext refusal that banking.py is known to raise (bad account
// type, currency, ...). Build it from a BankAccountValidationReason only.
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
