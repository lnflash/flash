import { checkedToUserId } from "@domain/accounts"
import { checkedToPhoneNumber, PhoneMetadataValidator } from "@domain/users"

import {
  MissingRegistrationPayloadPropertiesError,
  UnsupportedSchemaTypeError,
} from "./errors"

type RawPhoneMetadata = RawPhoneMetadataPayload | undefined

// Shared by both hooks: the phone and its carrier metadata are the only parts
// of the payload that exist before Kratos persists the identity.
const validatePhoneAndMetadata = ({
  phoneRaw,
  rawPhoneMetadata,
}: {
  phoneRaw: string
  rawPhoneMetadata: RawPhoneMetadata
}): PreRegistrationPayload | ValidationError => {
  const phoneChecked = checkedToPhoneNumber(phoneRaw)
  if (phoneChecked instanceof Error) return phoneChecked

  let phoneMetadata: PhoneMetadata | undefined = undefined
  if (rawPhoneMetadata !== undefined) {
    const validated = PhoneMetadataValidator().validate(rawPhoneMetadata)
    if (validated instanceof Error) return validated
    phoneMetadata = validated
  }

  return { phone: phoneChecked, phoneMetadata }
}

export const RegistrationPayloadValidator = (
  schemaId: SchemaId,
): RegistrationPayloadValidator => {
  const validate = (rawBody: {
    identity_id?: string
    phone?: string
    schema_id?: string
    transient_payload?: { phoneMetadata?: RawPhoneMetadataPayload }
  }): RegistrationPayload | ValidationError => {
    const {
      identity_id: userIdRaw,
      phone: phoneRaw,
      schema_id: schemaIdRaw,
      transient_payload,
    } = rawBody

    if (!(phoneRaw && userIdRaw && schemaIdRaw)) {
      return new MissingRegistrationPayloadPropertiesError()
    }

    if (schemaIdRaw !== schemaId) {
      return new UnsupportedSchemaTypeError()
    }

    const userIdChecked = checkedToUserId(userIdRaw)
    if (userIdChecked instanceof Error) return userIdChecked

    const checked = validatePhoneAndMetadata({
      phoneRaw,
      rawPhoneMetadata: transient_payload?.phoneMetadata,
    })
    if (checked instanceof Error) return checked

    return {
      userId: userIdChecked,
      phone: checked.phone,
      phoneMetadata: checked.phoneMetadata,
    }
  }

  return {
    validate,
  }
}

// For the pre-persist hook. `identity_id` is deliberately ignored: Kratos
// only assigns the real id at persist time, so the hook receives the nil uuid
// ("00000000-0000-0000-0000-000000000000"). Nothing may be looked up by it.
export const PreRegistrationPayloadValidator = (
  schemaId: SchemaId,
): PreRegistrationPayloadValidator => {
  const validate = (rawBody: {
    identity_id?: string | null
    phone?: string
    schema_id?: string
    transient_payload?: { phoneMetadata?: RawPhoneMetadataPayload } | null
    flow_id?: string | null
    flow_type?: string | null
  }): PreRegistrationPayload | ValidationError => {
    const { phone: phoneRaw, schema_id: schemaIdRaw, transient_payload } = rawBody

    if (!(phoneRaw && schemaIdRaw)) {
      return new MissingRegistrationPayloadPropertiesError()
    }

    if (schemaIdRaw !== schemaId) {
      return new UnsupportedSchemaTypeError()
    }

    return validatePhoneAndMetadata({
      phoneRaw,
      rawPhoneMetadata: transient_payload?.phoneMetadata,
    })
  }

  return {
    validate,
  }
}
