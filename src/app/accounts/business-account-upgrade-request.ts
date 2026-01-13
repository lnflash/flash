import { InvalidAccountStatusError } from "@domain/errors"
import { AccountLevel, checkedToAccountLevel } from "@domain/accounts"

import { AccountsRepository, UsersRepository } from "@services/mongoose"
import { IdentityRepository } from "@services/kratos"
import ErpNext from "@services/frappe/ErpNext"
import { AccountUpgradeRequest } from "@services/frappe/models/AccountUpgradeRequest"
import { baseLogger } from "@services/logger"

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
  idDocument?: string // Can be base64-encoded file data (data:mime;base64,...) or filename
}

// Parse base64 data URL and extract buffer and mime type
const parseBase64DataUrl = (
  dataUrl: string,
): { buffer: Buffer; mimeType: string; extension: string } | null => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null

  const mimeType = match[1]
  const base64Data = match[2]
  const buffer = Buffer.from(base64Data, "base64")

  // Get file extension from mime type
  const extensionMap: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
  }
  const extension = extensionMap[mimeType] || "bin"

  return { buffer, mimeType, extension }
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
    username: (account.username as string) || account.id,
    currentLevel: account.level,
    requestedLevel: checkedLevel,
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

  // Upload ID document file if provided as base64
  if (input.idDocument && requestResult.name) {
    const parsed = parseBase64DataUrl(input.idDocument)
    if (parsed) {
      const filename = `id-document-${requestResult.name}.${parsed.extension}`
      const uploadResult = await ErpNext.uploadFile(
        parsed.buffer,
        filename,
        AccountUpgradeRequest.doctype,
        requestResult.name,
      )
      if (uploadResult instanceof Error) {
        // Log warning but don't fail the request - the upgrade request was created
        baseLogger.warn(
          { err: uploadResult, docname: requestResult.name },
          "Failed to upload ID document, but upgrade request was created",
        )
      }
    }
  }

  // Pro accounts auto-upgrade immediately (no manual approval needed)
  if (checkedLevel === AccountLevel.Pro) {
    const upgradeResult = await updateAccountLevel({
      id: accountId,
      level: checkedLevel,
    })
    if (upgradeResult instanceof Error) return upgradeResult
  }

  return true
}
