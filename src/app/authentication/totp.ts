import { AuthTokenUserIdMismatchError } from "@domain/authentication/errors"
import {
  validateKratosToken,
  kratosValidateTotp,
  kratosInitiateTotp,
  kratosElevatingSessionWithTotp,
  kratosRemoveTotp,
} from "@services/kratos"

import { UsersRepository } from "@services/mongoose"

export const initiateTotpRegistration = async ({
  authToken,
}: {
  authToken: AuthToken
}): Promise<InitiateTotpRegistrationResult | KratosError> => {
  return kratosInitiateTotp(authToken)
}

export const validateTotpRegistration = async ({
  authToken,
  totpCode,
  totpRegistrationId,
  userId,
}: {
  authToken: AuthToken
  totpCode: TotpCode
  totpRegistrationId: TotpRegistrationId
  userId: UserId
}): Promise<User | ApplicationError> => {
  const validation = await kratosValidateTotp({ authToken, totpCode, totpRegistrationId })
  if (validation instanceof Error) return validation

  const res = await validateKratosToken(authToken)
  if (res instanceof Error) return res

  if (res.kratosUserId !== userId) return new AuthTokenUserIdMismatchError()

  const me = await UsersRepository().findById(res.kratosUserId)
  if (me instanceof Error) return me

  return me
}

export const elevatingSessionWithTotp = async ({
  authToken,
  totpCode,
}: {
  authToken: AuthToken
  totpCode: TotpCode
}): Promise<boolean | KratosError> => {
  return kratosElevatingSessionWithTotp({ authToken, totpCode })
}

export const removeTotp = async ({
  authToken,
  userId,
}: {
  authToken: AuthToken
  userId: UserId
}): Promise<User | ApplicationError> => {
  const res = await validateKratosToken(authToken)
  if (res instanceof Error) return res

  if (res.kratosUserId !== userId) return new AuthTokenUserIdMismatchError()

  const res2 = await kratosRemoveTotp(authToken)
  if (res2 instanceof Error) return res2

  const me = await UsersRepository().findById(userId)
  if (me instanceof Error) return me

  return me
}
