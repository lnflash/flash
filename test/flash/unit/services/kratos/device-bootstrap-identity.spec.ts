jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({ fns }: { fns: object }) => fns,
}))
const mockCreate = jest.fn(),
  mockGet = jest.fn(),
  mockUpdate = jest.fn(),
  mockFlow = jest.fn(),
  mockLogin = jest.fn()
jest.mock("@services/kratos/private", () => ({
  kratosAdmin: {
    createIdentity: (...args: unknown[]) => mockCreate(...args),
    getIdentity: (...args: unknown[]) => mockGet(...args),
    updateIdentity: (...args: unknown[]) => mockUpdate(...args),
  },
  kratosPublic: {
    createNativeLoginFlow: (...args: unknown[]) => mockFlow(...args),
    updateLoginFlow: (...args: unknown[]) => mockLogin(...args),
  },
}))
jest.mock("@services/kratos/auth-phone-no-password", () => ({
  AuthWithPhonePasswordlessService: jest.fn(),
}))

import { createHash } from "crypto"

import { AuthWithUsernamePasswordDeviceIdService } from "@services/kratos/auth-username-password-deviceid"
import { readDeviceBootstrapIdentity } from "@services/kratos/device-bootstrap-identity"
import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"

const DEVICE = "11111111-1111-4111-8111-111111111111",
  PASSWORD = "22222222-2222-4222-8222-222222222222",
  USER = "kratos-owner"
const marker = {
  version: 1,
  deviceIdHash: createHash("sha256").update(DEVICE).digest("hex"),
}
const identity = () => ({
  id: USER,
  state: "active",
  schema_id: "username_password_deviceid_v0",
  traits: { username: DEVICE },
  metadata_admin: { deviceBootstrap: marker },
})
const login = () => ({
  data: {
    session_token: "fixture-session",
    session: { active: true, identity: identity() },
  },
})
const authenticate = () =>
  AuthWithUsernamePasswordDeviceIdService().createIdentityWithSession({
    username: DEVICE as IdentityUsername,
    password: PASSWORD as IdentityPassword,
  })
beforeEach(() => {
  jest.resetAllMocks()
  mockCreate.mockResolvedValue({ data: identity() })
  mockFlow.mockResolvedValue({ data: { id: "login-flow" } })
  mockLogin.mockResolvedValue(login())
  mockGet.mockResolvedValue({ data: identity() })
})

it("creates atomic admin-only provenance with the device identity and password, without account/wallet mutation", async () => {
  const result = await authenticate()
  expect(result).toEqual({
    authToken: "fixture-session",
    kratosUserId: USER,
    newEntity: true,
  })
  const body = mockCreate.mock.calls[0][0].createIdentityBody
  expect(body.metadata_admin).toEqual({ deviceBootstrap: marker })
  expect(body.schema_id).toBe("username_password_deviceid_v0")
  expect(body.traits).toEqual({ username: DEVICE })
  expect(body.credentials.password.config.password).toBe(PASSWORD)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it("authenticates a legacy409 identity without adding or rewriting creation provenance", async () => {
  mockCreate.mockRejectedValue({ isAxiosError: true, response: { status: 409 } })
  mockLogin.mockResolvedValue({
    data: {
      ...login().data,
      session: { active: true, identity: { ...identity(), metadata_admin: {} } },
    },
  })
  const result = await authenticate()
  expect(result).toEqual({
    authToken: "fixture-session",
    kratosUserId: USER,
    newEntity: false,
  })
  expect(mockUpdate).not.toHaveBeenCalled()
  expect(mockCreate).toHaveBeenCalledTimes(1)
})

it.each([
  "inactive-session",
  "inactive-identity",
  "phone-schema",
  "wrong-username",
  "missing-token",
  "oversize-token",
])("refuses %s before handing a token/owner to bootstrap", async (mode) => {
  const reply = login()
  if (mode === "inactive-session") reply.data.session.active = false
  if (mode === "inactive-identity") reply.data.session.identity.state = "inactive"
  if (mode === "phone-schema")
    reply.data.session.identity.schema_id = "phone_no_password_v0"
  if (mode === "wrong-username")
    reply.data.session.identity.traits.username = "another-device"
  if (mode === "missing-token") reply.data.session_token = ""
  if (mode === "oversize-token") reply.data.session_token = "x".repeat(16_385)
  mockLogin.mockResolvedValue(reply)
  expect(await authenticate()).toBeInstanceOf(Error)
})

it("does not continue after a non409 identity-creation failure and does not echo credential/provider prose", async () => {
  mockCreate.mockRejectedValue({
    isAxiosError: true,
    response: { status: 503 },
    message: PASSWORD,
  })
  const result = await authenticate()
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).not.toContain(PASSWORD)
  expect(mockLogin).not.toHaveBeenCalled()
})

it("freshly reads the exact authenticated identity including only TOTP credential metadata", async () => {
  const proof = await readDeviceBootstrapIdentity(USER)
  expect(mockGet).toHaveBeenCalledWith({ id: USER, includeCredential: ["totp"] })
  expect(proof).toEqual({
    id: USER,
    schema: "username_password_deviceid_v0",
    state: "active",
    username: DEVICE,
    totpEnabled: false,
    bootstrap: marker,
  })
})

it("reports TOTP presence without returning its secret/config or any password credential", async () => {
  mockGet.mockResolvedValue({
    data: {
      ...identity(),
      credentials: { totp: { type: "totp", config: { secret: "PRIVATE_TOTP_SECRET" } } },
    },
  })
  const proof = await readDeviceBootstrapIdentity(USER)
  expect(proof.totpEnabled).toBe(true)
  expect(JSON.stringify(proof)).not.toContain("PRIVATE_TOTP_SECRET")
  expect(proof).not.toHaveProperty("credentials")
  expect(proof).not.toHaveProperty("password")
})

it("does not adopt malformed admin provenance or leak raw identity-reader errors", async () => {
  mockGet.mockResolvedValueOnce({
    data: { ...identity(), metadata_admin: { deviceBootstrap: "not-a-marker" } },
  })
  await expect(readDeviceBootstrapIdentity(USER)).rejects.toMatchObject({
    code: "DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY",
  })
  mockGet.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_DETAILS"))
  const result = await readDeviceBootstrapIdentity(USER).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(DeviceBootstrapError)
  expect((result as Error).message).not.toContain("PRIVATE_PROVIDER_DETAILS")
})
