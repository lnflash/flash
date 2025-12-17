import { InvalidAccountStatusError } from "@domain/errors"
import { checkedToAccountLevel } from "@domain/accounts"

import { AccountsRepository, UsersRepository } from "@services/mongoose"
import { IdentityRepository } from "@services/kratos"
import ErpNext from "@services/frappe/ErpNext"

import { updateAccountLevel } from "./update-account-level"

type BusinessUpgradeRequestInput = {
  accountId: AccountId
  level: number
  fullName: string
  phoneNumber?: string
  email?: string
  businessName?: string
  businessAddress?: string
  terminalRequested?: boolean
  bankName?: string
  bankBranch?: string
  accountType?: string
  currency?: string
  accountNumber?: number
  idDocument?: string
}

// Composable validation helpers
type Validator<T> = (value: T) => true | ApplicationError
type CheckedValidator<T, R> = (value: T) => R | ApplicationError

const validate = <T>(value: T, validators: Validator<T>[]): T | ApplicationError => {
  for (const validator of validators) {
    const result = validator(value)
    if (result instanceof Error) return result
  }
  return value
}

const validateAndTransform = <T, R>(
  value: T,
  transform: CheckedValidator<T, R>,
  validators: Validator<R>[],
): R | ApplicationError => {
  const transformed = transform(value)
  if (transformed instanceof Error) return transformed
  return validate(transformed, validators)
}

const isGreaterThan =
  (threshold: number, errorMsg: string): Validator<number> =>
  (value) =>
    value > threshold ? true : new InvalidAccountStatusError(errorMsg)

const isNotEqual =
  (compareTo: number, errorMsg: string): Validator<number> =>
  (value) =>
    value !== compareTo ? true : new InvalidAccountStatusError(errorMsg)

export const businessAccountUpgradeRequest = async (
  input: BusinessUpgradeRequestInput,
): Promise<true | ApplicationError> => {
  const { accountId, level, fullName } = input

  const accountsRepo = AccountsRepository()
  const usersRepo = UsersRepository()

  const account = await accountsRepo.findById(accountId)
  if (account instanceof Error) return account

  const checkedLevel = validateAndTransform(level, checkedToAccountLevel, [
    isGreaterThan(account.level - 1, "Cannot request account level downgrade"),
    isNotEqual(account.level, "Account is already at requested level"),
  ])
  if (checkedLevel instanceof Error) return checkedLevel

  const user = await usersRepo.findById(account.kratosUserId)
  if (user instanceof Error) return user

  const identity = await IdentityRepository().getIdentity(account.kratosUserId)
  if (identity instanceof Error) return identity

  const storedPhone = (user.phone as string) || ""
  const storedEmail = (identity.email as string) || ""

  // Validate phone number if provided and account has existing phone
  if (input.phoneNumber && storedPhone && input.phoneNumber !== storedPhone) {
    return new InvalidAccountStatusError("Phone number does not match account records")
  }

  // Validate email if provided and account has existing email
  if (input.email && storedEmail && input.email !== storedEmail) {
    return new InvalidAccountStatusError("Email does not match account records")
  }

  const requestResult = await ErpNext.createUpgradeRequest({
    currentLevel: account.level,
    requestedLevel: checkedLevel,
    username: (account.username as string) || account.id,
    fullName,
    phoneNumber: storedPhone,
    email: storedEmail || undefined,
    businessName: input.businessName,
    businessAddress: input.businessAddress,
    terminalRequested: input.terminalRequested,
    bankName: input.bankName,
    bankBranch: input.bankBranch,
    accountType: input.accountType,
    currency: input.currency,
    accountNumber: input.accountNumber,
    idDocument: input.idDocument,
  })

  if (requestResult instanceof Error) return requestResult

  // Level 2 (Pro) auto-upgrades immediately
  if (checkedLevel === 2) {
    const upgradeResult = await updateAccountLevel({
      id: accountId,
      level: checkedLevel,
    })
    if (upgradeResult instanceof Error) return upgradeResult
  }

  return true
}
