import { KRATOS_CALLBACK_API_KEY } from "@config"

import { CallbackSecretValidator } from "@domain/authentication/secret-validator"
import { PreRegistrationPayloadValidator } from "@domain/authentication/registration-payload-validator"
import { PhoneAlreadyExistsError } from "@domain/authentication/errors"
import { CouldNotFindUserFromPhoneError } from "@domain/errors"

import { addAttributesToCurrentSpan } from "@services/tracing"
import { SchemaIdType } from "@services/kratos"
import { UsersRepository } from "@services/mongoose"

// Pre-persist half of registration. Kratos calls this BEFORE it commits the
// identity (web_hook with `response.parse: true`); a rejection here aborts the
// sign-up with nothing written anywhere. It therefore must not write anything
// either: every check is read-only, and the account itself is still created by
// the post-persist /registration hook once the identity exists.
//
// `identity_id` is absent/nil at this point and is never inspected.
export const validatePreRegistrationPayload = async ({
  secret,
  body,
}: {
  secret: string | undefined
  body: {
    identity_id?: string | null
    phone?: string
    schema_id?: string
    transient_payload?: { phoneMetadata?: RawPhoneMetadataPayload } | null
    flow_id?: string | null
    flow_type?: string | null
  }
}): Promise<true | ApplicationError> => {
  addAttributesToCurrentSpan({
    "preregistration.schema_id": body.schema_id,
  })

  const isValidKey = CallbackSecretValidator(KRATOS_CALLBACK_API_KEY).authorize(secret)
  if (isValidKey instanceof Error) {
    return isValidKey
  }

  const payload = PreRegistrationPayloadValidator(
    SchemaIdType.PhoneNoPasswordV0,
  ).validate(body)
  if (payload instanceof Error) return payload

  // The post-persist hook upserts the users document by phone, which has a
  // unique index. A document already holding this phone is exactly the
  // DuplicateKeyForPersistError that used to strand the identity; reject it
  // here while nothing has been committed.
  const existing = await UsersRepository().findByPhone(payload.phone)
  if (existing instanceof CouldNotFindUserFromPhoneError) return true
  if (existing instanceof Error) return existing

  return new PhoneAlreadyExistsError()
}
