import { KRATOS_CALLBACK_API_KEY, getDefaultAccountsConfig } from "@config"

import { CallbackSecretValidator } from "@domain/authentication/secret-validator"
import { RegistrationPayloadValidator } from "@domain/authentication/registration-payload-validator"
import { ErrorLevel } from "@domain/shared"
import { InvalidPhoneNumber, InvalidUserId } from "@domain/errors"

import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"
import { SchemaIdType } from "@services/kratos"

import { createAccountWithPhoneIdentifier } from "@app/accounts"

export const createAccountFromRegistrationPayload = async ({
  secret,
  body,
}: {
  secret: string | undefined
  body: {
    identity_id?: string
    phone?: string
    schema_id?: string
  }
}): Promise<Account | ApplicationError> => {
  addAttributesToCurrentSpan({
    "registration.schema": SchemaIdType.PhoneNoPasswordV0,
    "registration.outcome": "received",
  })

  const isValidKey = CallbackSecretValidator(KRATOS_CALLBACK_API_KEY).authorize(secret)
  if (isValidKey instanceof Error) {
    addAttributesToCurrentSpan({ "registration.outcome": "callback_rejected" })
    return isValidKey
  }

  const regPayloadValidator = RegistrationPayloadValidator(SchemaIdType.PhoneNoPasswordV0)
  const regPayload = regPayloadValidator.validate(body)
  if (regPayload instanceof Error) {
    addAttributesToCurrentSpan({ "registration.outcome": "invalid_payload" })
    if (regPayload instanceof InvalidUserId || regPayload instanceof InvalidPhoneNumber) {
      recordExceptionInCurrentSpan({
        error: new Error("Registration payload validation failed"),
        level: ErrorLevel.Critical,
        attributes: {
          "registration.reason":
            regPayload instanceof InvalidUserId ? "invalid_identity" : "invalid_phone",
        },
      })
    }
    return regPayload
  }

  const { userId, phone, phoneMetadata } = regPayload
  const account = await createAccountWithPhoneIdentifier({
    newAccountInfo: { phone, kratosUserId: userId },
    config: getDefaultAccountsConfig(),
    phoneMetadata,
  })
  if (account instanceof Error) {
    addAttributesToCurrentSpan({ "registration.outcome": "creation_failed" })
    recordExceptionInCurrentSpan({
      error: new Error("Account registration failed"),
      level: ErrorLevel.Critical,
    })
  } else {
    addAttributesToCurrentSpan({ "registration.outcome": "created" })
  }

  return account
}
