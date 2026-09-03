import {
  MissingRegistrationPayloadPropertiesError,
  UnsupportedSchemaTypeError,
} from "@domain/authentication/errors"
import { PreRegistrationPayloadValidator } from "@domain/authentication/registration-payload-validator"
import { InvalidPhoneNumber } from "@domain/errors"
import {
  InvalidCarrierForPhoneMetadataError,
  InvalidCarrierTypeForPhoneMetadataError,
  InvalidCountryCodeForPhoneMetadataError,
  PhoneMetadataValidationError,
} from "@domain/users/errors"

import { SchemaIdType } from "@services/kratos"

import { randomPhone } from "test/galoy/helpers/random"

// Kratos assigns the identity id only at persist time; the pre-persist hook
// receives this placeholder and the validator must never look at it.
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

const validCarrier = {
  error_code: "",
  mobile_country_code: "338",
  mobile_network_code: "050",
  name: "Digicel",
  type: "mobile",
}

describe("PreRegistrationPayloadValidator", () => {
  const validator = PreRegistrationPayloadValidator(SchemaIdType.PhoneNoPasswordV0)

  it("passes a valid body with the nil identity id Kratos sends pre-persist", () => {
    const phone = randomPhone()

    const validated = validator.validate({
      identity_id: NIL_UUID,
      phone,
      schema_id: SchemaIdType.PhoneNoPasswordV0,
      transient_payload: { phoneMetadata: { carrier: validCarrier, countryCode: "JM" } },
    })

    expect(validated).toStrictEqual({
      phone,
      phoneMetadata: { carrier: validCarrier, countryCode: "JM" },
    })
  })

  it("does not require identity_id at all", () => {
    const phone = randomPhone()

    for (const identity_id of [undefined, null, "not-a-uuid"]) {
      const validated = validator.validate({
        identity_id,
        phone,
        schema_id: SchemaIdType.PhoneNoPasswordV0,
      })
      expect(validated).toStrictEqual({ phone, phoneMetadata: undefined })
    }
  })

  it("passes without transient metadata (null or absent)", () => {
    const phone = randomPhone()

    expect(
      validator.validate({ phone, schema_id: SchemaIdType.PhoneNoPasswordV0 }),
    ).toStrictEqual({ phone, phoneMetadata: undefined })
    expect(
      validator.validate({
        phone,
        schema_id: SchemaIdType.PhoneNoPasswordV0,
        transient_payload: null,
      }),
    ).toStrictEqual({ phone, phoneMetadata: undefined })
  })

  it("returns missing inputs error when phone or schema_id is absent", () => {
    expect(validator.validate({})).toBeInstanceOf(
      MissingRegistrationPayloadPropertiesError,
    )
    expect(
      validator.validate({
        identity_id: NIL_UUID,
        schema_id: SchemaIdType.PhoneNoPasswordV0,
      }),
    ).toBeInstanceOf(MissingRegistrationPayloadPropertiesError)
    expect(
      validator.validate({ identity_id: NIL_UUID, phone: randomPhone() }),
    ).toBeInstanceOf(MissingRegistrationPayloadPropertiesError)
  })

  it("returns unsupported schema error", () => {
    expect(
      validator.validate({ phone: randomPhone(), schema_id: "email_no_password_v0" }),
    ).toBeInstanceOf(UnsupportedSchemaTypeError)
  })

  it("returns invalid phone error", () => {
    expect(
      validator.validate({
        phone: "invalid-phone",
        schema_id: SchemaIdType.PhoneNoPasswordV0,
      }),
    ).toBeInstanceOf(InvalidPhoneNumber)
  })

  it("rejects a carrier type outside the known set (today's orphan source)", () => {
    const validated = validator.validate({
      identity_id: NIL_UUID,
      phone: randomPhone(),
      schema_id: SchemaIdType.PhoneNoPasswordV0,
      transient_payload: {
        phoneMetadata: { carrier: { ...validCarrier, type: "" }, countryCode: "NG" },
      },
    })
    expect(validated).toBeInstanceOf(InvalidCarrierTypeForPhoneMetadataError)
    // The hook route matches on the parent class.
    expect(validated).toBeInstanceOf(PhoneMetadataValidationError)
  })

  it("rejects malformed carrier metadata", () => {
    const badCarrier = validator.validate({
      phone: randomPhone(),
      schema_id: SchemaIdType.PhoneNoPasswordV0,
      transient_payload: {
        phoneMetadata: { carrier: "not-an-object", countryCode: "JM" } as never,
      },
    })
    expect(badCarrier).toBeInstanceOf(InvalidCarrierForPhoneMetadataError)
    expect(badCarrier).toBeInstanceOf(PhoneMetadataValidationError)

    const noCountry = validator.validate({
      phone: randomPhone(),
      schema_id: SchemaIdType.PhoneNoPasswordV0,
      transient_payload: {
        phoneMetadata: { carrier: validCarrier } as never,
      },
    })
    expect(noCountry).toBeInstanceOf(InvalidCountryCodeForPhoneMetadataError)
    expect(noCountry).toBeInstanceOf(PhoneMetadataValidationError)
  })
})
