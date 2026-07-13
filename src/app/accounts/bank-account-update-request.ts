import { AccountsRepository } from "@services/mongoose"
import ErpNext from "@services/frappe/ErpNext"
import { BankAccount } from "@services/frappe/models/BankAccount"
import { BankAccountUpdateRequest } from "@services/frappe/models/BankAccountUpdateRequest"
import { RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"
import { ValidationError } from "@domain/shared"
import {
  BankAccountQueryError,
  BankAccountUpdateRequestQueryError,
} from "@services/frappe/errors"

type UpdateStatusResponse = {
  id: string
  status: RequestStatus
}

export type BankAccountUpdateInput = {
  bankAccountId: string
  // Proposed new values for the account.
  bankAccount: BankAccount
}

// Submits a request to change the details of an already-approved bank account.
// The change does NOT take effect immediately: a human reviews it and, on
// approval, the ERPNext Bank Account is patched in place. Until then cashouts
// continue to settle to the account's current details.
export const createBankAccountUpdateRequest = async (
  accountId: AccountId,
  input: BankAccountUpdateInput,
): Promise<UpdateStatusResponse | ApplicationError> => {
  const accountsRepo = AccountsRepository()

  const account = await accountsRepo.findById(accountId)
  if (account instanceof Error) return account

  const erpParty = account.erpParty
  if (!erpParty) {
    return new ValidationError("This account has no bank accounts to update.")
  }

  // Verify the target account exists and belongs to this user, and capture its
  // current currency (which is locked — see below).
  const bankAccounts = await ErpNext.getBankAccountsByCustomer(erpParty)
  if (bankAccounts instanceof BankAccountQueryError) return bankAccounts

  const current = bankAccounts.find((b) => b.name === input.bankAccountId)
  if (!current) {
    return new ValidationError("Bank account not found for this user.")
  }

  // Validate the proposed values server-side — do not trust the client. Empty or
  // out-of-set values would otherwise reach ERPNext as an opaque Link/insert
  // failure, or blank the live account when an admin approves the request.
  const proposed = input.bankAccount
  const allowedAccountTypes = ["Chequing", "Savings"]
  if (!proposed.bank || proposed.bank.trim().length < 2) {
    return new ValidationError("Bank name is required.")
  }
  if (!proposed.branch_code || proposed.branch_code.trim().length < 2) {
    return new ValidationError("Bank branch is required.")
  }
  if (!allowedAccountTypes.includes(proposed.account_type)) {
    return new ValidationError("Account type must be Chequing or Savings.")
  }
  if (!proposed.bank_account_no || proposed.bank_account_no.trim().length < 4) {
    return new ValidationError("A valid account number is required.")
  }

  // v1: currency is locked. It drives the JMD-vs-USD cashout payout branch and
  // the account's grouping in the app, so a currency change is "add a new
  // account", not "update this one".
  if (input.bankAccount.currency !== current.currency) {
    return new ValidationError(
      "Changing the account currency is not supported. Please add a new account instead.",
    )
  }

  // Snapshot prior open requests, but close them only AFTER the replacement is
  // created — closing first would leave the user with no open request at all if
  // the create then failed.
  const priorOpen = await ErpNext.getOpenBankAccountUpdateRequestsForAccount(
    input.bankAccountId,
  )
  if (priorOpen instanceof BankAccountUpdateRequestQueryError) return priorOpen

  const req = new BankAccountUpdateRequest(
    "", // name — assigned by ERPNext
    erpParty,
    input.bankAccountId,
    RequestStatus.Pending,
    input.bankAccount,
  )

  const result = await ErpNext.postBankAccountUpdateRequest(req)
  if (result instanceof Error) return result

  // Best-effort supersede of the now-stale prior requests. A failure here only
  // leaves an extra Pending request — which the admin approval path also closes —
  // and the new request is already live, so we do not fail the mutation for it.
  const priorNames = priorOpen.map((r) => r.name).filter((name) => name !== result.name)
  if (priorNames.length > 0) {
    await ErpNext.closeBankAccountUpdateRequests(priorNames)
  }

  return { id: result.name, status: RequestStatus.Pending }
}
