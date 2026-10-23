import { validatePreRegistrationPayload } from "@app/authentication/validate-preregistration-payload"
import {
  InvalidSecretForAuthNCallbackError,
  MissingSecretForAuthNCallbackError,
  PhoneAlreadyRegisteredError,
  UnsupportedSchemaTypeError,
} from "@domain/authentication/errors"
import { CouldNotFindUserFromPhoneError, UnknownRepositoryError } from "@domain/errors"
import { InvalidCarrierTypeForPhoneMetadataError } from "@domain/users/errors"
import { SchemaIdType } from "@services/kratos"
import { UsersRepository } from "@services/mongoose"
import { addAttributesToCurrentSpan } from "@services/tracing"

const CALLBACK_KEY = "unit-test-callback-key"

jest.mock("@config", () => ({
  KRATOS_CALLBACK_API_KEY: "unit-test-callback-key",
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/kratos", () => ({
  SchemaIdType: { PhoneNoPasswordV0: "phone_no_password_v0" },
}))

const mockFindByPhone = jest.fn()
const mockFindById = jest.fn()
const mockUpdate = jest.fn()
jest.mock("@services/mongoose", () => ({
  UsersRepository: jest.fn(() => ({
    findById: mockFindById,
    findByPhone: mockFindByPhone,
    update: mockUpdate,
  })),
}))

const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const phone = "+18765550123"
const carrier = {
  error_code: "",
  mobile_country_code: "338",
  mobile_network_code: "050",
  name: "Digicel",
  type: "mobile",
}

const body = (overrides: Record<string, unknown> = {}) => ({
  identity_id: NIL_UUID,
  phone,
  schema_id: SchemaIdType.PhoneNoPasswordV0,
  transient_payload: { phoneMetadata: { carrier, countryCode: "JM" } },
  flow_id: "flow",
  flow_type: "api",
  ...overrides,
})

describe("validatePreRegistrationPayload", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindByPhone.mockReset()
    mockFindById.mockReset()
    mockUpdate.mockReset()
    mockFindByPhone.mockResolvedValue(new CouldNotFindUserFromPhoneError())
  })

  it("passes when the phone is valid and not bound to any users document", async () => {
    const result = await validatePreRegistrationPayload({
      secret: CALLBACK_KEY,
      body: body(),
    })

    expect(result).toBe(true)
    expect(UsersRepository).toHaveBeenCalled()
    expect(mockFindByPhone).toHaveBeenCalledWith(phone)
  })

  it("never writes and never looks anything up by the nil identity id", async () => {
    await validatePreRegistrationPayload({ secret: CALLBACK_KEY, body: body() })

    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockFindById).not.toHaveBeenCalled()
    expect(mockFindByPhone).toHaveBeenCalledTimes(1)
    expect(mockFindByPhone.mock.calls[0][0]).not.toBe(NIL_UUID)
  })

  it("does not write even when it rejects", async () => {
    mockFindByPhone.mockResolvedValue({ id: "other-user", phone })

    await validatePreRegistrationPayload({ secret: CALLBACK_KEY, body: body() })

    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("rejects a missing or wrong secret before touching the payload", async () => {
    expect(
      await validatePreRegistrationPayload({ secret: undefined, body: body() }),
    ).toBeInstanceOf(MissingSecretForAuthNCallbackError)
    expect(
      await validatePreRegistrationPayload({ secret: "wrong", body: body() }),
    ).toBeInstanceOf(InvalidSecretForAuthNCallbackError)
    expect(mockFindByPhone).not.toHaveBeenCalled()
  })

  it("rejects an invalid carrier type without touching the repository", async () => {
    const result = await validatePreRegistrationPayload({
      secret: CALLBACK_KEY,
      body: body({
        transient_payload: {
          phoneMetadata: { carrier: { ...carrier, type: "" }, countryCode: "NG" },
        },
      }),
    })

    expect(result).toBeInstanceOf(InvalidCarrierTypeForPhoneMetadataError)
    expect(mockFindByPhone).not.toHaveBeenCalled()
  })

  it("rejects an unsupported schema", async () => {
    expect(
      await validatePreRegistrationPayload({
        secret: CALLBACK_KEY,
        body: body({ schema_id: "email_no_password_v0" }),
      }),
    ).toBeInstanceOf(UnsupportedSchemaTypeError)
  })

  it("rejects a phone already bound to a users document (the DuplicateKey source)", async () => {
    mockFindByPhone.mockResolvedValue({ id: "other-user", phone })

    const result = await validatePreRegistrationPayload({
      secret: CALLBACK_KEY,
      body: body(),
    })

    expect(result).toBeInstanceOf(PhoneAlreadyRegisteredError)
  })

  it("surfaces repository failures so the route answers 500 and the sign-up aborts", async () => {
    const repoError = new UnknownRepositoryError("mongo down")
    mockFindByPhone.mockResolvedValue(repoError)

    const result = await validatePreRegistrationPayload({
      secret: CALLBACK_KEY,
      body: body(),
    })

    expect(result).toBe(repoError)
  })

  it("never inspects unauthenticated payload fields for span metadata", async () => {
    const untrustedBody = Object.defineProperties(
      {},
      {
        schema_id: {
          get() {
            throw new Error("PRIVATE_SCHEMA_MUST_NOT_BE_READ")
          },
        },
        phone: {
          get() {
            throw new Error("PRIVATE_PHONE_MUST_NOT_BE_READ")
          },
        },
      },
    )
    expect(
      await validatePreRegistrationPayload({
        secret: "PRIVATE_WRONG_SECRET",
        body: untrustedBody,
      }),
    ).toBeInstanceOf(InvalidSecretForAuthNCallbackError)
    expect(mockFindByPhone).not.toHaveBeenCalled()
    expect(jest.mocked(addAttributesToCurrentSpan).mock.calls).toEqual([
      [
        {
          "preregistration.schema_id": SchemaIdType.PhoneNoPasswordV0,
          "preregistration.outcome": "received",
        },
      ],
      [{ "preregistration.outcome": "callback_rejected" }],
    ])
  })

  it("omits caller schema, phone and callback key from invalid-payload diagnostics", async () => {
    const result = await validatePreRegistrationPayload({
      secret: CALLBACK_KEY,
      body: body({ schema_id: "PRIVATE_SCHEMA_TEXT", phone: "+18765550999" }),
    })
    expect(result).toBeInstanceOf(UnsupportedSchemaTypeError)
    const attributes = JSON.stringify(jest.mocked(addAttributesToCurrentSpan).mock.calls)
    expect(attributes).not.toContain("PRIVATE_SCHEMA_TEXT")
    expect(attributes).not.toContain("+18765550999")
    expect(attributes).not.toContain(CALLBACK_KEY)
    expect(attributes).toContain("invalid_payload")
    expect(mockFindByPhone).not.toHaveBeenCalled()
  })
})
