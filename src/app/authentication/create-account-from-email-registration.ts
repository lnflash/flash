import { KRATOS_CALLBACK_API_KEY, getDefaultAccountsConfig } from "@config"

import { CallbackSecretValidator } from "@domain/authentication/secret-validator"
import { RegistrationPayloadValidator } from "@domain/authentication/registration-payload-validator"
import { ErrorLevel } from "@domain/shared"
import { InvalidEmailAddress, InvalidUserId } from "@domain/errors"

import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"
import { SchemaIdType } from "@services/kratos"

import { createAccountWithEmailIdentifier } from "@app/accounts"

export const createAccountFromEmailRegistrationPayload = async ({
  secret,
  body,
}: {
  secret: string | undefined
  body: {
    identity_id?: string
    email?: string
    schema_id?: string
  }
}): Promise<Account | ApplicationError> => {
  addAttributesToCurrentSpan({
    "registration.body": JSON.stringify(body),
  })

  const isValidKey = CallbackSecretValidator(KRATOS_CALLBACK_API_KEY).authorize(secret)
  if (isValidKey instanceof Error) {
    return isValidKey
  }

  const regPayloadValidator = RegistrationPayloadValidator(SchemaIdType.EmailNoPasswordV0)
  const regPayload = regPayloadValidator.validate(body)
  if (regPayload instanceof Error) {
    if (
      regPayload instanceof InvalidUserId ||
      regPayload instanceof InvalidEmailAddress
    ) {
      recordExceptionInCurrentSpan({
        error: regPayload,
        level: ErrorLevel.Critical,
        attributes: {
          userIdRaw: body.identity_id,
          emailRaw: body.email,
        },
      })
    }
    return regPayload
  }

  const { userId, email } = regPayload
  if (!email) {
    return new InvalidEmailAddress("Email is required for email registration")
  }

  const account = await createAccountWithEmailIdentifier({
    newAccountInfo: { email, kratosUserId: userId },
    config: getDefaultAccountsConfig(),
  })
  if (account instanceof Error) {
    recordExceptionInCurrentSpan({
      error: account,
      level: ErrorLevel.Critical,
      attributes: {
        userId,
        email,
      },
    })
  }

  return account
}
