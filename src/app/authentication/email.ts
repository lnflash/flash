import { AccountAlreadyHasEmailError } from "@domain/authentication/errors"
import { AuthWithEmailPasswordlessService, IdentityRepository } from "@services/kratos"
import { SchemaIdType } from "@services/kratos/schema"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { upgradeAccountFromDeviceToEmail } from "@app/accounts"

export const addEmailToIdentity = async ({
  email,
  userId,
}: {
  email: EmailAddress
  userId: UserId
}): Promise<AddEmailToIdentityResult | KratosError> => {
  const authServiceEmail = AuthWithEmailPasswordlessService()

  const hasEmail = await authServiceEmail.hasEmail({ kratosUserId: userId })
  if (hasEmail instanceof Error) return hasEmail
  if (hasEmail) return new AccountAlreadyHasEmailError()

  // Check if this is a device account upgrade
  const identityRepo = IdentityRepository()
  const identity = await identityRepo.getIdentity(userId)
  if (identity instanceof Error) return identity

  const isDeviceAccountUpgrade =
    identity.schema === SchemaIdType.UsernamePasswordDeviceIdV0

  const res = await authServiceEmail.addUnverifiedEmailToIdentity({
    email,
    kratosUserId: userId,
  })
  if (res instanceof Error) return res

  // If this was a device account upgrade, also upgrade the MongoDB account
  if (isDeviceAccountUpgrade) {
    const accountUpgradeRes = await upgradeAccountFromDeviceToEmail({
      userId,
      email,
    })
    if (accountUpgradeRes instanceof Error) return accountUpgradeRes
  }

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
