import { AccountAlreadyHasEmailError } from "@domain/authentication/errors"
import { AuthWithEmailPasswordlessService, IdentityRepository } from "@services/kratos"
import { SchemaIdType } from "@services/kratos/schema"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { upgradeAccountFromDeviceToEmail } from "@app/accounts"

/**
 * Adds email to an authenticated user's identity
 *
 * Handles two flows:
 * 1. TRIAL device account → Email account (upgrade)
 *    - Upgrades Kratos schema and MongoDB records
 *    - Sends verification email
 *
 * 2. Phone account → Phone+Email account (add email)
 *    - Adds email to existing phone account
 *    - Sends verification email
 *
 * @param email - Email address to add
 * @param userId - Authenticated user's ID
 * @returns Email registration ID and updated user, or error
 */
export const addEmailToIdentity = async ({
  email,
  userId,
}: {
  email: EmailAddress
  userId: UserId
}): Promise<AddEmailToIdentityResult | KratosError> => {
  const authServiceEmail = AuthWithEmailPasswordlessService()

  // Prevent duplicate emails
  const hasEmail = await authServiceEmail.hasEmail({ kratosUserId: userId })
  if (hasEmail instanceof Error) return hasEmail
  if (hasEmail) return new AccountAlreadyHasEmailError()

  // Detect if this is a device account upgrade or phone account email addition
  const identityRepo = IdentityRepository()
  const identity = await identityRepo.getIdentity(userId)
  if (identity instanceof Error) return identity

  const isDeviceAccountUpgrade =
    identity.schema === SchemaIdType.UsernamePasswordDeviceIdV0

  // Update Kratos identity (handles schema upgrade internally)
  const res = await authServiceEmail.addUnverifiedEmailToIdentity({
    email,
    kratosUserId: userId,
  })
  if (res instanceof Error) return res

  // For device account upgrades, also update MongoDB (account level, user email)
  // For phone accounts, MongoDB is already updated via addUnverifiedEmailToIdentity
  if (isDeviceAccountUpgrade) {
    const accountUpgradeRes = await upgradeAccountFromDeviceToEmail({
      userId,
      email,
    })
    if (accountUpgradeRes instanceof Error) return accountUpgradeRes
  }

  // Send verification code to email
  const emailRegistrationId = await authServiceEmail.sendEmailWithCode({ email })
  if (emailRegistrationId instanceof Error) return emailRegistrationId

  const user = await UsersRepository().findById(userId)
  if (user instanceof Error) return user

  return { emailRegistrationId, me: user }
}

export const verifyEmail = async ({
  emailRegistrationId,
  code,
}: {
  emailRegistrationId: EmailRegistrationId
  code: EmailCode
}): Promise<User | KratosError | RepositoryError> => {
  baseLogger.info({ emailRegistrationId }, "RequestVerifyEmail called")

  const authServiceEmail = AuthWithEmailPasswordlessService()
  const res = await authServiceEmail.validateCode({
    code,
    emailFlowId: emailRegistrationId,
  })
  if (res instanceof Error) return res

  const user = await UsersRepository().findById(res.kratosUserId)
  if (user instanceof Error) return user

  return user
}

export const removeEmail = async ({
  userId,
}: {
  userId: UserId
}): Promise<User | KratosError> => {
  const authServiceEmail = AuthWithEmailPasswordlessService()
  const email = await authServiceEmail.removeEmailFromIdentity({ kratosUserId: userId })
  if (email instanceof Error) return email

  const user = await UsersRepository().findById(userId)
  if (user instanceof Error) return user

  const deletedEmails = [...(user.deletedEmails ?? [])]
  deletedEmails.push(email)

  const updatedUser = await UsersRepository().update({
    ...user,
    deletedEmails,
  })
  if (updatedUser instanceof Error) return updatedUser

  return user
}
