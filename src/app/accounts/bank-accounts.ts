import { AccountsRepository } from "@services/mongoose"
import ErpNext from "@services/frappe/ErpNext"
import { BankAccount } from "@services/frappe/models/BankAccount"
import { ValidationError } from "@domain/shared"
import { RateLimitConfig } from "@domain/rate-limit"
import { consumeLimiter } from "@services/rate-limit"
import { baseLogger } from "@services/logger"
import {
  BankAccountNotOwnedError,
  BankAccountQueryError,
  BankAccountUpgradeRequiredError,
} from "@services/frappe/errors"

// Self-serve management of the customer's ERPNext (Jamaican) bank accounts.
// Unlike createBankAccountUpdateRequest, every write here takes effect
// INSTANTLY — there is no human review. So:
//   - `erpParty` only ever comes from the authenticated account record;
//   - the target account is checked against the customer's own list before
//     ERPNext is asked to touch it (ERPNext re-checks — defense in depth);
//   - values are validated here, not trusted from the client.

const ALLOWED_ACCOUNT_TYPES = ["Chequing", "Savings"]
// Cashout only settles JMD or USD.
const ALLOWED_CURRENCIES = ["JMD", "USD"]

export type BankAccountDetailsInput = {
  bankName: string
  bankBranch: string
  accountType: string
  accountNumber: string
  accountName?: string | null
}

export type AddBankAccountInput = BankAccountDetailsInput & {
  currency: string
  setDefault?: boolean | null
}

// No currency: it is locked. It drives the JMD-vs-USD cashout payout branch, so
// a currency change is "add a new account", not "update this one".
export type UpdateBankAccountInput = BankAccountDetailsInput & {
  bankAccountId: string
}

type BankAccountDetails = {
  bankName: string
  bankBranch: string
  accountType: string
  accountNumber: string
  accountName?: string
}

const resolveErpParty = async (
  accountId: AccountId,
): Promise<string | ApplicationError> => {
  if (!ErpNext) return new BankAccountQueryError("ERPNext service not configured")

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  if (!account.erpParty) return new BankAccountUpgradeRequiredError()

  const limitOk = await consumeLimiter({
    rateLimitConfig: RateLimitConfig.bankAccountManage,
    keyToConsume: accountId,
  })
  if (limitOk instanceof Error) return limitOk

  return account.erpParty
}

// Same rules as the update-request flow, plus bank membership: with no reviewer
// in the loop ERPNext would mint a Bank master for any unknown name, and that
// master then shows up in every customer's supportedBanks picker.
const validateDetails = async (
  input: BankAccountDetailsInput,
): Promise<BankAccountDetails | ApplicationError> => {
  const bankName = (input.bankName ?? "").trim()
  const bankBranch = (input.bankBranch ?? "").trim()
  const accountType = (input.accountType ?? "").trim()
  const accountNumber = (input.accountNumber ?? "").trim()
  const accountName = (input.accountName ?? "").trim()

  if (bankName.length < 2) return new ValidationError("Bank name is required.")
  if (bankBranch.length < 2) return new ValidationError("Bank branch is required.")
  if (!ALLOWED_ACCOUNT_TYPES.includes(accountType)) {
    return new ValidationError("Account type must be Chequing or Savings.")
  }
  if (accountNumber.length < 4) {
    return new ValidationError("A valid account number is required.")
  }

  const banks = await ErpNext.listBanks()
  if (banks instanceof Error) return banks
  if (!banks.some((bank) => bank.name === bankName)) {
    return new ValidationError("Bank is not supported.")
  }

  return {
    bankName,
    bankBranch,
    accountType,
    accountNumber,
    accountName: accountName || undefined,
  }
}

const findOwned = async (
  erpParty: string,
  bankAccountId: string,
): Promise<BankAccount | BankAccountQueryError | BankAccountNotOwnedError> => {
  const bankAccounts = await ErpNext.getBankAccountsByCustomer(erpParty)
  if (bankAccounts instanceof BankAccountQueryError) return bankAccounts

  const owned = bankAccounts.find((b) => b.name === bankAccountId)
  if (!owned) return new BankAccountNotOwnedError("Bank account not found for this user.")
  return owned
}

export const addBankAccount = async (
  accountId: AccountId,
  input: AddBankAccountInput,
): Promise<BankAccount | ApplicationError> => {
  const erpParty = await resolveErpParty(accountId)
  if (erpParty instanceof Error) return erpParty

  const details = await validateDetails(input)
  if (details instanceof Error) return details

  const currency = (input.currency ?? "").trim().toUpperCase()
  if (!ALLOWED_CURRENCIES.includes(currency)) {
    return new ValidationError("Currency must be JMD or USD.")
  }

  const created = await ErpNext.createBankAccount({
    erpParty,
    ...details,
    currency,
    setDefault: Boolean(input.setDefault),
  })
  if (created instanceof Error) return created

  // Re-read so the GraphQL NonNull fields come from what ERPNext stored.
  return findOwned(erpParty, created.bankAccountId)
}

export const updateBankAccount = async (
  accountId: AccountId,
  input: UpdateBankAccountInput,
): Promise<BankAccount | ApplicationError> => {
  const erpParty = await resolveErpParty(accountId)
  if (erpParty instanceof Error) return erpParty

  const current = await findOwned(erpParty, input.bankAccountId)
  if (current instanceof Error) return current

  const details = await validateDetails(input)
  if (details instanceof Error) return details

  // The ERPNext endpoint requires a currency on every save; pin it to the
  // stored one so an update can never change it.
  const updated = await ErpNext.updateBankAccount({
    bankAccountId: input.bankAccountId,
    erpParty,
    ...details,
    currency: current.currency,
  })
  if (updated instanceof Error) return updated

  // Close any still-open review requests for this account: approving a stale
  // one later would overwrite the edit the customer just made. Best-effort — the
  // edit is already live, so a failure here must not fail the mutation.
  const open = await ErpNext.getOpenBankAccountUpdateRequestsForAccount(
    input.bankAccountId,
  )
  const closed =
    open instanceof Error
      ? open
      : await ErpNext.closeBankAccountUpdateRequests(open.map((r) => r.name))
  if (closed instanceof Error) {
    baseLogger.error(
      { bankAccountId: input.bankAccountId, erpParty, error: closed.name },
      "Bank account updated but its open update requests could not be closed",
    )
  }

  return findOwned(erpParty, input.bankAccountId)
}

export const setDefaultBankAccount = async (
  accountId: AccountId,
  { bankAccountId }: { bankAccountId: string },
): Promise<BankAccount | ApplicationError> => {
  const erpParty = await resolveErpParty(accountId)
  if (erpParty instanceof Error) return erpParty

  const current = await findOwned(erpParty, bankAccountId)
  if (current instanceof Error) return current

  const result = await ErpNext.setDefaultBankAccount({ bankAccountId, erpParty })
  if (result instanceof Error) return result

  return findOwned(erpParty, bankAccountId)
}

export const deleteBankAccount = async (
  accountId: AccountId,
  { bankAccountId }: { bankAccountId: string },
): Promise<true | ApplicationError> => {
  const erpParty = await resolveErpParty(accountId)
  if (erpParty instanceof Error) return erpParty

  const current = await findOwned(erpParty, bankAccountId)
  if (current instanceof Error) return current

  const result = await ErpNext.deleteBankAccount({ bankAccountId, erpParty })
  if (result instanceof Error) return result

  return true
}
