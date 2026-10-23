const mockAuthenticate = jest.fn(),
  mockBootstrap = jest.fn(),
  mockLimit = jest.fn(),
  mockLock = jest.fn()
jest.mock("@app/accounts/device-account-bootstrap", () => ({
  resumeDeviceAccountBootstrap: (...args: unknown[]) => mockBootstrap(...args),
}))
jest.mock("@app/accounts", () => ({ upgradeAccountFromDeviceToPhone: jest.fn() }))
jest.mock("@app/wallets", () => ({ getBalanceForWallet: jest.fn() }))
jest.mock("@services/kratos", () => ({
  AuthWithUsernamePasswordDeviceIdService: () => ({
    createIdentityWithSession: (...args: unknown[]) => mockAuthenticate(...args),
  }),
}))
jest.mock("@services/lock", () => ({
  redlock: (...args: unknown[]) => mockLock(...args),
}))
jest.mock("@services/twilio", () => ({
  isPhoneCodeValid: jest.fn(),
  TwilioClient: jest.fn(),
}))
jest.mock("@services/alerts/ops-events", () => ({ notifyOpsEvent: jest.fn() }))
jest.mock("@services/mongoose", () => ({ WalletsRepository: jest.fn() }))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))
jest.mock("@domain/accounts-ips/ip-metadata-authorizer", () => ({
  IPMetadataAuthorizer: jest.fn(),
}))
jest.mock("@services/ipfetcher", () => ({ IpFetcher: jest.fn() }))
jest.mock("@app/authentication/ratelimits", () => ({
  checkFailedLoginAttemptPerIpLimits: (...args: unknown[]) => mockLimit(...args),
  checkFailedLoginAttemptPerLoginIdentifierLimits: jest.fn(),
  rewardFailedLoginAttemptPerIpLimits: jest.fn(),
  rewardFailedLoginAttemptPerLoginIdentifierLimits: jest.fn(),
}))
jest.mock("@config", () => ({
  getAccountsOnboardConfig: () => ({ ipMetadataValidationSettings: { enabled: false } }),
}))

import { createHash } from "crypto"

import { loginWithDevice } from "@app/authentication/login"
import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"

const DEVICE = "11111111-1111-4111-8111-111111111111",
  PASSWORD = "22222222-2222-4222-8222-222222222222"
const request = (signal?: { aborted: boolean }) =>
  loginWithDevice({
    username: DEVICE,
    password: PASSWORD,
    deviceId: DEVICE,
    ip: "127.0.0.1" as IpAddress,
    signal,
  })
beforeEach(() => {
  jest.clearAllMocks()
  mockLimit.mockResolvedValue(true)
  mockAuthenticate.mockResolvedValue({
    authToken: "fixture-token",
    kratosUserId: "owner",
    newEntity: false,
  })
  mockBootstrap.mockResolvedValue(true)
  mockLock.mockImplementation(
    async ({
      asyncFn,
    }: {
      asyncFn: (signal: { aborted: boolean }) => Promise<unknown>
    }) => asyncFn({ aborted: false }),
  )
})

it("authenticates before every owned readiness repair, including existing newEntity:false identities", async () => {
  const order: string[] = []
  mockAuthenticate.mockImplementation(async () => {
    order.push("authenticated")
    return { authToken: "fixture-token", kratosUserId: "owner", newEntity: false }
  })
  mockBootstrap.mockImplementation(async () => {
    order.push("bootstrap")
    return true
  })
  expect(await request()).toBe("fixture-token")
  expect(order).toEqual(["authenticated", "bootstrap"])
  expect(mockLock.mock.calls[0][0].path).toBe(
    "locks:device-bootstrap-identity:" +
      createHash("sha256").update(DEVICE).digest("hex"),
  )
  expect(mockLock.mock.calls[0][0].path).not.toContain(PASSWORD)
  expect(mockLock.mock.calls[0][0].path).not.toContain(DEVICE)
})

it("never runs repair after failed password authentication", async () => {
  mockAuthenticate.mockResolvedValue(new Error("Invalid credentials"))
  expect(await request()).toBeInstanceOf(Error)
  expect(mockBootstrap).not.toHaveBeenCalled()
})

it.each([
  "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED",
  "DEVICE_BOOTSTRAP_RETRY_REQUIRED",
  "DEVICE_BOOTSTRAP_OWNER_MISMATCH",
  "DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY",
] as const)("does not return a minted token when readiness returns %s", async (code) => {
  mockBootstrap.mockResolvedValue(new DeviceBootstrapError(code))
  expect(await request()).toMatchObject({ code })
})

it("never returns a token after HTTP cancellation or account-readiness cancellation", async () => {
  const signal = { aborted: true }
  expect(await request(signal)).toBeInstanceOf(DeviceBootstrapError)
  expect(mockAuthenticate).not.toHaveBeenCalled()
  signal.aborted = false
  mockBootstrap.mockImplementation(async () => {
    signal.aborted = true
    return true
  })
  expect(await request(signal)).toBeInstanceOf(DeviceBootstrapError)
})

it("does not leak invalid password input in errors or start authentication", async () => {
  const result = await loginWithDevice({
    username: DEVICE,
    password: "PRIVATE_NON_UUID_PASSWORD",
    deviceId: DEVICE,
    ip: "127.0.0.1" as IpAddress,
  })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).not.toContain("PRIVATE_NON_UUID_PASSWORD")
  expect(mockAuthenticate).not.toHaveBeenCalled()
  expect(mockBootstrap).not.toHaveBeenCalled()
})
