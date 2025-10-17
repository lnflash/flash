import { checkedToUserId } from "@domain/accounts"
import {
  checkedToPhoneNumber,
  checkedToEmailAddress,
  PhoneMetadataValidator,
} from "@domain/users"
import { SchemaIdType } from "@services/kratos/schema"

import {
  MissingRegistrationPayloadPropertiesError,
  UnsupportedSchemaTypeError,
} from "./errors"

export const RegistrationPayloadValidator = (
  schemaId: SchemaId,
): RegistrationPayloadValidator => {
  const validate = (rawBody: {
    identity_id?: string
    phone?: string
    email?: string
    schema_id?: string
    transient_payload?: { phoneMetadata?: Record<string, Record<string, string>> }
  }): RegistrationPayload | ValidationError => {
    const {
      identity_id: userIdRaw,
      phone: phoneRaw,
      email: emailRaw,
      schema_id: schemaIdRaw,
      transient_payload,
    } = rawBody

    // Check for required fields based on schema type
    if (schemaId === SchemaIdType.EmailNoPasswordV0) {
      if (!(emailRaw && userIdRaw && schemaIdRaw)) {
        return new MissingRegistrationPayloadPropertiesError()
      }
    } else {
      if (!(phoneRaw && userIdRaw && schemaIdRaw)) {
        return new MissingRegistrationPayloadPropertiesError()
      }
    }

    if (schemaIdRaw !== schemaId) {
      return new UnsupportedSchemaTypeError()
    }

    const userIdChecked = checkedToUserId(userIdRaw)
    if (userIdChecked instanceof Error) return userIdChecked

    // Handle email schema
    if (schemaId === SchemaIdType.EmailNoPasswordV0) {
      const emailChecked = checkedToEmailAddress(emailRaw as string)
      if (emailChecked instanceof Error) return emailChecked

      return {
        userId: userIdChecked,
        email: emailChecked,
      }
    }

    // Handle phone schema (existing logic)
    const phoneChecked = checkedToPhoneNumber(phoneRaw as string)
    if (phoneChecked instanceof Error) return phoneChecked

    const rawPhoneMetadata = transient_payload?.phoneMetadata

    let phoneMetadata: PhoneMetadata | undefined = undefined
    if (rawPhoneMetadata !== undefined) {
      const validated = PhoneMetadataValidator().validate(rawPhoneMetadata)
      if (validated instanceof Error) return validated
      phoneMetadata = validated
    }

    return {
      userId: userIdChecked,
      phone: phoneChecked,
      phoneMetadata,
    }
  }

  return {
    validate,
  }
}
