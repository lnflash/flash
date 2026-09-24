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
  // App-layer checks (src/app/accounts/bank-accounts.ts). Same allowlist so
  // they reach the customer as BANK_ACCOUNT_INVALID with their own text.
  BankBranch: "Bank branch is required.",
  BankBranchTooLong: "Bank branch must be 100 characters or fewer.",
  AccountNameTooLong: "Account name must be 80 characters or fewer.",
  BankNotSupported: "Bank is not supported.",
  InvalidCharacters: "Bank account details contain invalid characters.",
  TooManyAccounts:
    "You can have at most 10 bank accounts. Delete one before adding another.",
} as const

export type BankAccountValidationReasonText =
  (typeof BankAccountValidationReason)[keyof typeof BankAccountValidationReason]

export const isBankAccountValidationReason = (message: string): boolean =>
  (Object.values(BankAccountValidationReason) as string[]).includes(message)

// A deliberate validation refusal, from the app layer or from banking.py.
// Build it from a BankAccountValidationReason only: the constructor accepts
// allowlisted text alone, so free text does not compile.
export class BankAccountValidationError extends ErpNextError {
  constructor(reason: BankAccountValidationReasonText) {
    super(reason)
  }
}
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
export class DecisionReasonQueryError extends ErpNextError {}
