const mockSession = jest.fn()
const mockIdentity = jest.fn()
const mockInitiate = jest.fn()
const mockValidate = jest.fn()
const mockValidateToken = jest.fn()
const mockFind = jest.fn()
jest.mock("@services/kratos/private", () => ({
  kratosPublic: { toSession: (...args: unknown[]) => mockSession(...args) },
  kratosAdmin: { getIdentity: (...args: unknown[]) => mockIdentity(...args) },
}))
jest.mock("@services/kratos", () => ({
  kratosInitiateTotp: (...args: unknown[]) => mockInitiate(...args),
  kratosValidateTotp: (...args: unknown[]) => mockValidate(...args),
  validateKratosToken: (...args: unknown[]) => mockValidateToken(...args),
}))
jest.mock("@services/mongoose", () => ({
  UsersRepository: () => ({ findById: (...args: unknown[]) => mockFind(...args) }),
}))

import {
  initiateTotpRegistration,
  validateTotpRegistration,
} from "@app/authentication/totp"
import {
  AuthTokenUserIdMismatchError,
  DeviceTotpRequiresPhoneUpgradeError,
  TotpEnrollmentUnavailableError,
} from "@domain/authentication/errors"
import { SchemaIdType } from "@services/kratos/schema"

const owner = "11111111-1111-4111-8111-111111111111" as UserId
const authToken = "fixture-session-token" as AuthToken
const input = { authToken, userId: owner }
const initiate = () => initiateTotpRegistration(input)
const validate = () =>
  validateTotpRegistration({
    ...input,
    totpCode: "123456" as TotpCode,
    totpRegistrationId: "existing-flow" as TotpRegistrationId,
  })
const account = { id: owner, phone: "+18765551234", level: 1 }

beforeEach(() => {
  jest.resetAllMocks()
  mockSession.mockResolvedValue({ data: { active: true, identity: { id: owner } } })
  mockIdentity.mockResolvedValue({
    data: { id: owner, state: "active", schema_id: SchemaIdType.PhoneNoPasswordV0 },
  })
  mockInitiate.mockResolvedValue({
    totpSecret: "fixture-secret",
    totpRegistrationId: "flow",
  })
  mockValidate.mockResolvedValue(true)
  mockValidateToken.mockResolvedValue({ kratosUserId: owner })
  mockFind.mockResolvedValue(account)
})

it.each([initiate, validate])(
  "rejects device-schema enrollment before any settings effect",
  async (run) => {
    mockIdentity.mockResolvedValue({
      data: {
        id: owner,
        state: "active",
        schema_id: SchemaIdType.UsernamePasswordDeviceIdV0,
        traits: { phone: "+18765551234", email: "fixture@example.com" },
      },
    })
    expect(await run()).toBeInstanceOf(DeviceTotpRequiresPhoneUpgradeError)
    expect(mockInitiate).not.toHaveBeenCalled()
    expect(mockValidate).not.toHaveBeenCalled()
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockIdentity).toHaveBeenCalledWith({ id: owner })
  },
)

it.each([
  SchemaIdType.PhoneNoPasswordV0,
  SchemaIdType.PhoneEmailNoPasswordV0,
  SchemaIdType.EmailNoPasswordV0,
])("preserves setup and verification for fresh active %s identities", async (schema) => {
  mockIdentity.mockResolvedValue({
    data: { id: owner, state: "active", schema_id: schema },
  })
  expect(await initiate()).toEqual({
    totpSecret: "fixture-secret",
    totpRegistrationId: "flow",
  })
  expect(await validate()).toEqual(account)
  expect(mockInitiate).toHaveBeenCalledWith(authToken)
  expect(mockValidate).toHaveBeenCalledWith({
    authToken,
    totpCode: "123456",
    totpRegistrationId: "existing-flow",
  })
  expect(mockSession).toHaveBeenCalledTimes(2)
  expect(mockIdentity).toHaveBeenCalledTimes(2)
})

it.each([initiate, validate])(
  "rejects a foreign input token before revealing or enabling a secret",
  async (run) => {
    mockSession.mockResolvedValue({ data: { active: true, identity: { id: "foreign" } } })
    expect(await run()).toBeInstanceOf(AuthTokenUserIdMismatchError)
    expect(mockIdentity).not.toHaveBeenCalled()
    expect(mockInitiate).not.toHaveBeenCalled()
    expect(mockValidate).not.toHaveBeenCalled()
  },
)

it.each([
  "inactive-session",
  "missing-session-active",
  "inactive-identity",
  "missing-identity-state",
  "unknown-schema",
  "foreign-identity",
  "session-read-failure",
  "identity-read-failure",
])("fails closed for %s without provider settings effects", async (mode) => {
  if (mode === "inactive-session")
    mockSession.mockResolvedValue({ data: { active: false, identity: { id: owner } } })
  if (mode === "missing-session-active")
    mockSession.mockResolvedValue({ data: { identity: { id: owner } } })
  if (mode === "inactive-identity")
    mockIdentity.mockResolvedValue({
      data: { id: owner, state: "inactive", schema_id: SchemaIdType.PhoneNoPasswordV0 },
    })
  if (mode === "missing-identity-state")
    mockIdentity.mockResolvedValue({
      data: { id: owner, schema_id: SchemaIdType.PhoneNoPasswordV0 },
    })
  if (mode === "unknown-schema")
    mockIdentity.mockResolvedValue({
      data: { id: owner, state: "active", schema_id: "future-device-schema" },
    })
  if (mode === "foreign-identity")
    mockIdentity.mockResolvedValue({
      data: { id: "foreign", state: "active", schema_id: SchemaIdType.PhoneNoPasswordV0 },
    })
  if (mode === "session-read-failure")
    mockSession.mockRejectedValue(new Error("private-token-provider-detail"))
  if (mode === "identity-read-failure")
    mockIdentity.mockRejectedValue(new Error("private-token-provider-detail"))
  const result = await validate()
  expect(result).toBeInstanceOf(
    mode === "foreign-identity"
      ? AuthTokenUserIdMismatchError
      : TotpEnrollmentUnavailableError,
  )
  expect((result as Error).message).not.toContain("private-token-provider-detail")
  expect(mockInitiate).not.toHaveBeenCalled()
  expect(mockValidate).not.toHaveBeenCalled()
  expect(mockFind).not.toHaveBeenCalled()
})

it("checks fresh schema again when verifying a previously issued enrollment flow", async () => {
  expect(await initiate()).not.toBeInstanceOf(Error)
  mockIdentity.mockResolvedValue({
    data: {
      id: owner,
      state: "active",
      schema_id: SchemaIdType.UsernamePasswordDeviceIdV0,
    },
  })
  expect(await validate()).toBeInstanceOf(DeviceTotpRequiresPhoneUpgradeError)
  expect(mockValidate).not.toHaveBeenCalled()
})

it("keeps the post-mutation owner check and never returns another user's account", async () => {
  mockValidateToken.mockResolvedValue({ kratosUserId: "foreign" })
  expect(await validate()).toBeInstanceOf(AuthTokenUserIdMismatchError)
  expect(mockFind).not.toHaveBeenCalled()
})

it("propagates a rejected verification without a success readback or implicit retry", async () => {
  const rejected = new Error("fixture-rejected-code")
  mockValidate.mockResolvedValue(rejected)
  expect(await validate()).toBe(rejected)
  expect(mockValidate).toHaveBeenCalledTimes(1)
  expect(mockValidateToken).not.toHaveBeenCalled()
  expect(mockFind).not.toHaveBeenCalled()
})
