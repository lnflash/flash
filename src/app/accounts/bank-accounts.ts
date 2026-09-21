import { AccountsRepository } from "@services/mongoose"
import ErpNext from "@services/frappe/ErpNext"
import { BankAccount } from "@services/frappe/models/BankAccount"
import { ValidationError } from "@domain/shared"
import { RateLimitConfig } from "@domain/rate-limit"
import { consumeLimiter } from "@services/rate-limit"
import { baseLogger } from "@services/logger"
import {
  BankAccountDuplicateNumberError,
  BankAccountNotOwnedError,
  BankAccountQueryError,
  BankAccountUpgradeRequiredError,
  BankAccountValidationError,
  BankAccountValidationReason,
} from "@services/frappe/errors"

// Self-serve management of the customer's ERPNext (Jamaican) bank accounts.
// Unlike createBankAccountUpdateRequest, every write here takes effect
// INSTANTLY — there is no human review. So:
//   - `erpParty` only ever comes from the authenticated account record;
//   - the target account is checked against the customer's own list before
//     ERPNext is asked to touch it (ERPNext re-checks — defense in depth);
//   - values are validated here, not trusted from the client — format and
//     length included, because nobody reviews what ops later keys in as the
//     payout destination;
//   - a customer holds at most MAX_BANK_ACCOUNTS enabled accounts.
//
// Account-number uniqueness. ERPNext (admin_panel/api/banking.py) refuses a
// number that is already on another Bank Account. With no reviewer in front of
// that check, a distinct "duplicate" answer would let any upgraded customer
// probe whether a number is on file with Flash. Decision: the customer only
// gets BANK_ACCOUNT_DUPLICATE_NUMBER for a number on one of THEIR OWN visible
// accounts (checked here, against their own list). When ERPNext refuses a
// number this customer cannot see, the answer is the generic
// BANK_ACCOUNT_INVALID (BankAccountValidationReason.NumberNotAccepted), which
// points the real owner at support.

const ALLOWED_ACCOUNT_TYPES = ["Chequing", "Savings"]
// Cashout only settles JMD or USD.
const ALLOWED_CURRENCIES = ["JMD", "USD"]
export const MAX_BANK_ACCOUNTS = 10

// 4-34 characters (IBAN length is the ceiling), alphanumeric first, then
// alphanumerics, spaces and hyphens only.
const ACCOUNT_NUMBER_REGEX = /^[0-9A-Za-z][0-9A-Za-z -]{3,33}$/
// ERPNext Data fields and doc names stop at 140 characters. accountName becomes
// part of the Bank Account doc name ("{accountName} - {bank}", plus a
// disambiguating suffix), so it gets the tighter limit.
const MAX_BRANCH_LENGTH = 100
const MAX_ACCOUNT_NAME_LENGTH = 80
// Control characters and angle brackets: no markup or invisible characters in
// text that ops reads off a Cashout.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_REGEX = /[\u0000-\u001f\u007f<>]/

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
  // Checked before trimming: trim() would silently drop a leading or trailing
  // control character instead of rejecting it.
  for (const raw of [input.bankBranch, input.accountName, input.accountNumber]) {
    if (UNSAFE_TEXT_REGEX.test(raw ?? "")) {
      return new ValidationError("Bank account details contain invalid characters.")
    }
  }

  const bankName = (input.bankName ?? "").trim()
  const bankBranch = (input.bankBranch ?? "").trim()
  const accountType = (input.accountType ?? "").trim()
  const accountNumber = (input.accountNumber ?? "").trim()
  const accountName = (input.accountName ?? "").trim()

  if (bankName.length < 2) return new ValidationError("Bank name is required.")
  if (bankBranch.length < 2) return new ValidationError("Bank branch is required.")
  if (bankBranch.length > MAX_BRANCH_LENGTH) {
    return new ValidationError(
      `Bank branch must be ${MAX_BRANCH_LENGTH} characters or fewer.`,
    )
  }
  if (accountName.length > MAX_ACCOUNT_NAME_LENGTH) {
    return new ValidationError(
      `Account name must be ${MAX_ACCOUNT_NAME_LENGTH} characters or fewer.`,
    )
  }
  if (!ALLOWED_ACCOUNT_TYPES.includes(accountType)) {
    return new ValidationError("Account type must be Chequing or Savings.")
  }
  if (!ACCOUNT_NUMBER_REGEX.test(accountNumber)) {
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

// ERPNext answers "duplicate" for a number on ANY Bank Account. By the time it
// is asked, the customer's own visible accounts have been ruled out, so this is
// a number they cannot see — see the uniqueness note in the header.
const hideForeignDuplicate = <T>(result: T): T | BankAccountValidationError =>
  result instanceof BankAccountDuplicateNumberError
    ? new BankAccountValidationError(BankAccountValidationReason.NumberNotAccepted)
    : result

const sameNumber = (bankAccount: BankAccount, accountNumber: string): boolean =>
  (bankAccount.bank_account_no ?? "").trim() === accountNumber

// The write is committed; only reading it back failed. Failing the mutation
// would tell the customer that nothing happened — and a retried add then hits
// the duplicate check for an account they believe they never added.
const afterCommittedWrite = async ({
  erpParty,
  bankAccountId,
  fallback,
}: {
  erpParty: string
  bankAccountId: string
  fallback: BankAccount
}): Promise<BankAccount | ApplicationError> => {
  const fresh = await findOwned(erpParty, bankAccountId)
  if (fresh instanceof BankAccountQueryError) {
    baseLogger.error(
      { bankAccountId, erpParty, error: fresh.name },
      "Bank account write committed but the re-read failed; returning the written values",
    )
    return fallback
  }
  return fresh
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

  const existing = await ErpNext.getBankAccountsByCustomer(erpParty)
  if (existing instanceof BankAccountQueryError) return existing
  if (existing.length >= MAX_BANK_ACCOUNTS) {
    return new ValidationError(
      `You can have at most ${MAX_BANK_ACCOUNTS} bank accounts. Delete one before adding another.`,
    )
  }
  if (existing.some((b) => sameNumber(b, details.accountNumber))) {
    return new BankAccountDuplicateNumberError("Number is on the customer's own account")
  }

  const setDefault = Boolean(input.setDefault)
  const created = hideForeignDuplicate(
    await ErpNext.createBankAccount({ erpParty, ...details, currency, setDefault }),
  )
  if (created instanceof Error) return created

  // Re-read so the GraphQL NonNull fields come from what ERPNext stored.
  return afterCommittedWrite({
    erpParty,
    bankAccountId: created.bankAccountId,
    fallback: {
      name: created.bankAccountId,
      account_name: details.accountName,
      bank: details.bankName,
      bank_account_no: details.accountNumber,
      branch_code: details.bankBranch,
      account_type: details.accountType,
      currency,
      // ERPNext makes a customer's first account the default on its own.
      is_default: setDefault || existing.length === 0 ? 1 : 0,
    },
  })
}

export const updateBankAccount = async (
  accountId: AccountId,
  input: UpdateBankAccountInput,
): Promise<BankAccount | ApplicationError> => {
  const erpParty = await resolveErpParty(accountId)
  if (erpParty instanceof Error) return erpParty

  const owned = await ErpNext.getBankAccountsByCustomer(erpParty)
  if (owned instanceof BankAccountQueryError) return owned
  const current = owned.find((b) => b.name === input.bankAccountId)
  if (!current)
    return new BankAccountNotOwnedError("Bank account not found for this user.")

  const details = await validateDetails(input)
  if (details instanceof Error) return details

  const others = owned.filter((b) => b.name !== input.bankAccountId)
  if (others.some((b) => sameNumber(b, details.accountNumber))) {
    return new BankAccountDuplicateNumberError("Number is on the customer's own account")
  }

  // The ERPNext endpoint requires a currency on every save; pin it to the
  // stored one so an update can never change it.
  const updated = hideForeignDuplicate(
    await ErpNext.updateBankAccount({
      bankAccountId: input.bankAccountId,
      erpParty,
      ...details,
      currency: current.currency,
    }),
  )
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

  return afterCommittedWrite({
    erpParty,
    bankAccountId: input.bankAccountId,
    fallback: {
      ...current,
      // ERPNext keeps the stored account_name when none is sent.
      account_name: details.accountName ?? current.account_name,
      bank: details.bankName,
      bank_account_no: details.accountNumber,
      branch_code: details.bankBranch,
      account_type: details.accountType,
    },
  })
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

  return afterCommittedWrite({
    erpParty,
    bankAccountId,
    fallback: { ...current, is_default: 1 },
  })
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
