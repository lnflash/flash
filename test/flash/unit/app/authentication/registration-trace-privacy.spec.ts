jest.mock("@config", () => ({
  KRATOS_CALLBACK_API_KEY: "PRIVATE_CALLBACK_SECRET",
  getDefaultAccountsConfig: () => ({ fixture: true }),
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))
jest.mock("@services/kratos", () => ({
  SchemaIdType: { PhoneNoPasswordV0: "phone_no_password_v0" },
}))
jest.mock("@app/accounts", () => ({ createAccountWithPhoneIdentifier: jest.fn() }))
const mockValidate = jest.fn()
jest.mock("@domain/authentication/registration-payload-validator", () => ({
  RegistrationPayloadValidator: () => ({ validate: mockValidate }),
}))

import { createAccountFromRegistrationPayload } from "@app/authentication/create-account-from-registration-payload"
import { createAccountWithPhoneIdentifier } from "@app/accounts"
import {
  InvalidSecretForAuthNCallbackError,
  UnsupportedSchemaTypeError,
} from "@domain/authentication/errors"
import { InvalidPhoneNumber, InvalidUserId } from "@domain/errors"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

const body = {
  identity_id: "PRIVATE_USER_ID",
  phone: "PRIVATE_PHONE",
  schema_id: "PRIVATE_INPUT_SCHEMA",
  password: "PRIVATE_PASSWORD",
}
const create = jest.mocked(createAccountWithPhoneIdentifier)
function expectNoPrivateTelemetry() {
  const value = JSON.stringify(
    [
      jest.mocked(addAttributesToCurrentSpan).mock.calls,
      jest.mocked(recordExceptionInCurrentSpan).mock.calls,
    ],
    (_key, entry) =>
      entry instanceof Error
        ? { ...entry, message: entry.message, stack: entry.stack }
        : entry,
  )
  expect(value).not.toContain("PRIVATE_")
  expect(value).not.toContain("registration.body")
}
beforeEach(() => {
  jest.clearAllMocks()
  mockValidate.mockReturnValue({
    userId: "PRIVATE_USER_ID",
    phone: "PRIVATE_PHONE",
    phoneMetadata: { fixture: true },
  })
})

it("rejects unauthorized callbacks before inspecting/serializing any request body or emitting secret values", async () => {
  const get = jest.fn(() => {
    throw new Error("Must not inspect unauthorized payload")
  })
  const ownKeys = jest.fn(() => {
    throw new Error("Must not enumerate unauthorized payload")
  })
  const payload = new Proxy({}, { get, ownKeys })
  const result = await createAccountFromRegistrationPayload({
    secret: "PRIVATE_WRONG_SECRET",
    body: payload,
  })
  expect(result).toBeInstanceOf(InvalidSecretForAuthNCallbackError)
  expect(get).not.toHaveBeenCalled()
  expect(ownKeys).not.toHaveBeenCalled()
  expect(mockValidate).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(addAttributesToCurrentSpan).toHaveBeenCalledWith({
    "registration.outcome": "callback_rejected",
  })
  expectNoPrivateTelemetry()
})

it.each([
  new InvalidUserId("PRIVATE_INVALID_USER_ID"),
  new InvalidPhoneNumber("PRIVATE_INVALID_PHONE"),
  new UnsupportedSchemaTypeError("PRIVATE_SCHEMA"),
])(
  "preserves invalid-payload refusal identity with only fixed telemetry (case %#)",
  async (error) => {
    mockValidate.mockReturnValue(error)
    expect(
      await createAccountFromRegistrationPayload({
        secret: "PRIVATE_CALLBACK_SECRET",
        body,
      }),
    ).toBe(error)
    expect(create).not.toHaveBeenCalled()
    expect(addAttributesToCurrentSpan).toHaveBeenCalledWith({
      "registration.outcome": "invalid_payload",
    })
    expectNoPrivateTelemetry()
  },
)

it("preserves account provider inputs and the returned failure identity without collecting private exception text", async () => {
  const error = new Error("PRIVATE_PROVIDER_ERROR")
  create.mockResolvedValue(error as RepositoryError)
  expect(
    await createAccountFromRegistrationPayload({
      secret: "PRIVATE_CALLBACK_SECRET",
      body,
    }),
  ).toBe(error)
  expect(create).toHaveBeenCalledWith({
    newAccountInfo: { phone: "PRIVATE_PHONE", kratosUserId: "PRIVATE_USER_ID" },
    config: { fixture: true },
    phoneMetadata: { fixture: true },
  })
  expect(addAttributesToCurrentSpan).toHaveBeenCalledWith({
    "registration.outcome": "creation_failed",
  })
  expectNoPrivateTelemetry()
})

it("preserves successful account output and records only fixed schema/outcome", async () => {
  const account = { id: "PRIVATE_ACCOUNT_ID" } as Account
  create.mockResolvedValue(account)
  expect(
    await createAccountFromRegistrationPayload({
      secret: "PRIVATE_CALLBACK_SECRET",
      body,
    }),
  ).toBe(account)
  expect(addAttributesToCurrentSpan).toHaveBeenCalledWith({
    "registration.schema": "phone_no_password_v0",
    "registration.outcome": "received",
  })
  expect(addAttributesToCurrentSpan).toHaveBeenCalledWith({
    "registration.outcome": "created",
  })
  expectNoPrivateTelemetry()
})
