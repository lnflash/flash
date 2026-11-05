jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  getAccountsOnboardConfig: jest.fn(),
}))
jest.mock("@app/accounts", () => ({ upgradeAccountFromDeviceToPhone: jest.fn() }))
jest.mock("@app/accounts/device-account-bootstrap", () => ({
  resumeDeviceAccountBootstrap: jest.fn(),
}))
jest.mock("@app/wallets", () => ({ getBalanceForWallet: jest.fn() }))
jest.mock("@services/kratos", () => ({
  AuthWithPhonePasswordlessService: jest.fn(),
  AuthWithEmailPasswordlessService: jest.fn(),
  AuthWithUsernamePasswordDeviceIdService: jest.fn(),
  IdentityRepository: jest.fn(),
}))
jest.mock("@services/lock", () => ({
  redlock: jest.fn(
    async ({
      asyncFn,
    }: {
      asyncFn: (signal: { aborted: boolean }) => Promise<unknown>
    }) => asyncFn({ aborted: false }),
  ),
}))
jest.mock("@services/twilio", () => ({
  isPhoneCodeValid: jest.fn(),
  TwilioClient: jest.fn(),
}))
jest.mock("@services/ipfetcher", () => ({ IpFetcher: jest.fn() }))
jest.mock("@services/mongoose", () => ({ WalletsRepository: jest.fn() }))
jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
  opsEventsSettled: jest.fn(),
}))
jest.mock("@services/notifications/firebase", () => ({
  __esModule: true,
  default: { isDeviceTokenValid: jest.fn() },
}))
jest.mock("@services/geetest", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("@services/rate-limit", () => ({
  RedisRateLimitService: jest.fn(),
  consumeLimiter: jest.fn(),
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))
jest.mock("@app/authentication/ratelimits", () => ({
  checkFailedLoginAttemptPerIpLimits: jest.fn(),
  checkFailedLoginAttemptPerLoginIdentifierLimits: jest.fn(),
  rewardFailedLoginAttemptPerIpLimits: jest.fn(),
  rewardFailedLoginAttemptPerLoginIdentifierLimits: jest.fn(),
}))

import { getAccountsOnboardConfig } from "@config"
import { loginWithDevice, loginWithPhoneToken } from "@app/authentication/login"
import { requestEmailCode } from "@app/authentication/request-code"
import {
  checkFailedLoginAttemptPerIpLimits,
  checkFailedLoginAttemptPerLoginIdentifierLimits,
  rewardFailedLoginAttemptPerIpLimits,
  rewardFailedLoginAttemptPerLoginIdentifierLimits,
} from "@app/authentication/ratelimits"
import { resumeDeviceAccountBootstrap } from "@app/accounts/device-account-bootstrap"
import { IdentifierNotFoundError } from "@domain/authentication/errors"
import {
  UnauthorizedIPForOnboardingError,
  InvalidIpMetadataError,
  CouldNotFindUserFromPhoneError,
} from "@domain/errors"
import { UnknownIpFetcherServiceError } from "@domain/ipfetcher"
import { PhoneCodeInvalidError } from "@domain/phone-provider"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import {
  InvalidPhoneForOnboardingError,
  InvalidPhoneMetadataForOnboardingError,
} from "@domain/users/errors"
import { IpFetcher } from "@services/ipfetcher"
import {
  AuthWithEmailPasswordlessService,
  AuthWithPhonePasswordlessService,
  AuthWithUsernamePasswordDeviceIdService,
  IdentityRepository,
} from "@services/kratos"
import { baseLogger } from "@services/logger"
import { consumeLimiter } from "@services/rate-limit"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"
import { isPhoneCodeValid, TwilioClient } from "@services/twilio"

const privateValues = {
  ip: "203.0.113.81" as IpAddress,
  phone: "+18765550123" as PhoneNumber,
  email: "private.customer@example.test" as EmailAddress,
  code: "824691" as PhoneCode,
  city: "PRIVATE_CUSTOMER_CITY",
  provider: "PRIVATE_CUSTOMER_PROVIDER",
  carrier: "PRIVATE_CUSTOMER_CARRIER",
  token: "PRIVATE_AUTH_TOKEN",
  device: "11111111-1111-4111-8111-111111111111",
  password: "22222222-2222-4222-8222-222222222222",
}
const ipInfo = {
  provider: privateValues.provider,
  country: "PRIVATE_CUSTOMER_COUNTRY",
  isoCode: "JM",
  region: "PRIVATE_CUSTOMER_REGION",
  city: privateValues.city,
  type: "residential",
  asn: "AS1234",
  proxy: false,
}
const phoneInfo = {
  countryCode: "JM",
  carrier: {
    error_code: "",
    mobile_country_code: "338",
    mobile_network_code: "050",
    name: privateValues.carrier,
    type: "mobile",
  },
}
const settings = (): AccountsOnboardConfig => ({
  ipMetadataValidationSettings: {
    enabled: true,
    denyCountries: [],
    allowCountries: [],
    denyASNs: [],
    allowASNs: [],
    checkProxy: true,
  },
  phoneMetadataValidationSettings: {
    enabled: true,
    denyCountries: [],
    allowCountries: [],
  },
})
const mockIP = jest.fn(),
  mockCarrier = jest.fn(),
  mockCreate = jest.fn(),
  mockLogin = jest.fn(),
  mockIdentifier = jest.fn(),
  mockDevice = jest.fn(),
  mockEmail = jest.fn()
const requestPhone = () =>
  loginWithPhoneToken({
    phone: privateValues.phone,
    code: privateValues.code,
    ip: privateValues.ip,
  })
const requestDevice = () =>
  loginWithDevice({
    username: privateValues.device,
    password: privateValues.password,
    deviceId: privateValues.device,
    ip: privateValues.ip,
  })
const telemetry = () =>
  JSON.stringify({
    spans: jest.mocked(addAttributesToCurrentSpan).mock.calls,
    exceptions: jest
      .mocked(recordExceptionInCurrentSpan)
      .mock.calls.map(([{ error, ...args }]) => {
        if (!(error instanceof Error)) throw new Error("Expected a safe Error diagnostic")
        return {
          ...args,
          error: { ...error, message: error.message, stack: error.stack },
        }
      }),
    logs: [baseLogger.info, baseLogger.warn, baseLogger.error].flatMap(
      (log) => jest.mocked(log).mock.calls,
    ),
  })
const assertPrivateTelemetryAbsent = () => {
  for (const value of [
    ...Object.values(privateValues),
    ...Object.values(ipInfo).filter((value) => typeof value === "string"),
  ])
    expect(telemetry()).not.toContain(value)
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getAccountsOnboardConfig).mockReturnValue(settings())
  jest.mocked(IpFetcher).mockReturnValue({ fetchIPInfo: mockIP })
  jest
    .mocked(TwilioClient)
    .mockReturnValue({ getCarrier: mockCarrier } as unknown as ReturnType<
      typeof TwilioClient
    >)
  jest.mocked(AuthWithPhonePasswordlessService).mockReturnValue({
    createIdentityWithSession: mockCreate,
    loginToken: mockLogin,
  } as unknown as ReturnType<typeof AuthWithPhonePasswordlessService>)
  jest
    .mocked(AuthWithUsernamePasswordDeviceIdService)
    .mockReturnValue({ createIdentityWithSession: mockDevice } as unknown as ReturnType<
      typeof AuthWithUsernamePasswordDeviceIdService
    >)
  jest
    .mocked(AuthWithEmailPasswordlessService)
    .mockReturnValue({ sendEmailWithCode: mockEmail } as unknown as ReturnType<
      typeof AuthWithEmailPasswordlessService
    >)
  jest
    .mocked(IdentityRepository)
    .mockReturnValue({ getUserIdFromIdentifier: mockIdentifier } as unknown as ReturnType<
      typeof IdentityRepository
    >)
  jest.mocked(isPhoneCodeValid).mockResolvedValue(true)
  jest.mocked(checkFailedLoginAttemptPerIpLimits).mockResolvedValue(true)
  jest.mocked(checkFailedLoginAttemptPerLoginIdentifierLimits).mockResolvedValue(true)
  jest.mocked(rewardFailedLoginAttemptPerIpLimits).mockResolvedValue(true)
  jest.mocked(rewardFailedLoginAttemptPerLoginIdentifierLimits).mockResolvedValue(true)
  jest.mocked(resumeDeviceAccountBootstrap).mockResolvedValue(true)
  jest.mocked(consumeLimiter).mockResolvedValue(true)
  mockIP.mockResolvedValue(ipInfo)
  mockCarrier.mockResolvedValue(phoneInfo)
  mockIdentifier.mockResolvedValue(new IdentifierNotFoundError())
  mockCreate.mockResolvedValue({
    authToken: privateValues.token,
    kratosUserId: "private-owner",
  })
  mockLogin.mockResolvedValue({
    authToken: privateValues.token,
    kratosUserId: "private-owner",
  })
  mockDevice.mockResolvedValue({
    authToken: privateValues.token,
    kratosUserId: "private-owner",
    newEntity: false,
  })
  mockEmail.mockResolvedValue("PRIVATE_EMAIL_FLOW_ID")
})

describe("explicit onboarding telemetry boundary", () => {
  it("keeps exact phone, OTP, IP and carrier inputs for real authorization without copying metadata to spans", async () => {
    expect(await requestPhone()).toEqual({
      authToken: privateValues.token,
      totpRequired: false,
    })
    expect(isPhoneCodeValid).toHaveBeenCalledWith({
      phone: privateValues.phone,
      code: privateValues.code,
    })
    expect(mockIP).toHaveBeenCalledWith(privateValues.ip)
    expect(mockCarrier).toHaveBeenCalledWith(privateValues.phone)
    expect(mockCreate).toHaveBeenCalledWith({
      phone: privateValues.phone,
      phoneMetadata: phoneInfo,
    })
    expect(telemetry()).toContain("login.ipMetadataFetched")
    expect(telemetry()).toContain("login.phoneMetadataFetched")
    assertPrivateTelemetryAbsent()
  })

  it.each(["phone", "device"])(
    "returns the original %s IP-provider error while recording only a fixed diagnostic",
    async (kind) => {
      const error = Object.assign(
        new UnknownIpFetcherServiceError(Object.values(privateValues).join(" ")),
        { request: privateValues },
      )
      mockIP.mockResolvedValue(error)
      expect(await (kind === "phone" ? requestPhone() : requestDevice())).toBe(error)
      expect(recordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
      expect(mockCreate).not.toHaveBeenCalled()
      expect(mockDevice).not.toHaveBeenCalled()
      assertPrivateTelemetryAbsent()
    },
  )

  it("retains exact owned device credentials and post-auth readiness ordering", async () => {
    expect(await requestDevice()).toBe(privateValues.token)
    expect(mockDevice).toHaveBeenCalledWith({
      username: privateValues.device,
      password: privateValues.password,
    })
    expect(resumeDeviceAccountBootstrap).toHaveBeenCalledWith({
      userId: "private-owner",
      deviceId: privateValues.device,
      isCancelled: expect.any(Function),
    })
    expect(mockDevice.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(resumeDeviceAccountBootstrap).mock.invocationCallOrder[0],
    )
    assertPrivateTelemetryAbsent()
  })

  it.each(["phone", "device"])(
    "keeps %s onboarding denied for proxy metadata",
    async (kind) => {
      mockIP.mockResolvedValue({ ...ipInfo, proxy: true })
      expect(await (kind === "phone" ? requestPhone() : requestDevice())).toBeInstanceOf(
        UnauthorizedIPForOnboardingError,
      )
      expect(mockCreate).not.toHaveBeenCalled()
      expect(mockDevice).not.toHaveBeenCalled()
      assertPrivateTelemetryAbsent()
    },
  )

  it("keeps missing-IP-metadata refusal distinct", async () => {
    mockIP.mockResolvedValue({ ...ipInfo, asn: "" })
    expect(await requestPhone()).toBeInstanceOf(InvalidIpMetadataError)
    expect(mockCreate).not.toHaveBeenCalled()
    assertPrivateTelemetryAbsent()
  })

  it("still refuses forbidden phone carrier metadata without creating an identity", async () => {
    mockCarrier.mockResolvedValue({
      ...phoneInfo,
      carrier: { ...phoneInfo.carrier, type: "voip" },
    })
    expect(await requestPhone()).toBeInstanceOf(InvalidPhoneForOnboardingError)
    expect(mockCreate).not.toHaveBeenCalled()
    assertPrivateTelemetryAbsent()
  })

  it.each([true, false])(
    "retains carrier lookup failure policy when validation enabled=%s",
    async (enabled) => {
      const config = settings()
      config.phoneMetadataValidationSettings.enabled = enabled
      jest.mocked(getAccountsOnboardConfig).mockReturnValue(config)
      mockCarrier.mockResolvedValue(
        new CouldNotFindUserFromPhoneError("PRIVATE_CUSTOMER_CARRIER"),
      )
      const result = await requestPhone()
      const expectedError = expect.any(InvalidPhoneMetadataForOnboardingError)
      expect(result).toEqual(
        enabled ? expectedError : { authToken: privateValues.token, totpRequired: false },
      )
      expect(mockCreate.mock.calls).toEqual(
        enabled ? [] : [[{ phone: privateValues.phone, phoneMetadata: undefined }]],
      )
      assertPrivateTelemetryAbsent()
    },
  )

  it("does not consult onboarding providers after OTP rejection or for an existing phone identity", async () => {
    const otpError = new PhoneCodeInvalidError()
    jest.mocked(isPhoneCodeValid).mockResolvedValueOnce(otpError)
    expect(await requestPhone()).toBe(otpError)
    expect(mockIP).not.toHaveBeenCalled()
    mockIdentifier.mockResolvedValue("existing-owner")
    expect(await requestPhone()).toEqual({
      authToken: privateValues.token,
      totpRequired: false,
    })
    expect(mockLogin).toHaveBeenCalledWith({ phone: privateValues.phone })
    expect(mockIP).not.toHaveBeenCalled()
    expect(mockCarrier).not.toHaveBeenCalled()
    assertPrivateTelemetryAbsent()
  })
})

describe("email code request telemetry boundary", () => {
  const request = () =>
    requestEmailCode({ email: privateValues.email, ip: privateValues.ip })
  it("retains exact IP/email limiter keys and provider input without logging them", async () => {
    expect(await request()).toBe("PRIVATE_EMAIL_FLOW_ID")
    expect(consumeLimiter).toHaveBeenNthCalledWith(1, {
      rateLimitConfig: RateLimitConfig.requestCodeAttemptPerIp,
      keyToConsume: privateValues.ip,
    })
    expect(consumeLimiter).toHaveBeenNthCalledWith(2, {
      rateLimitConfig: RateLimitConfig.requestCodeAttemptPerLoginIdentifier,
      keyToConsume: privateValues.email,
    })
    expect(mockEmail).toHaveBeenCalledWith({ email: privateValues.email })
    assertPrivateTelemetryAbsent()
  })
  it.each([1, 2])(
    "keeps limiter %s refusal ahead of provider dispatch",
    async (refused) => {
      const error = new RateLimiterExceededError("PRIVATE_LIMITER_DIAGNOSTIC")
      jest
        .mocked(consumeLimiter)
        .mockImplementation(async () =>
          jest.mocked(consumeLimiter).mock.calls.length === refused ? error : true,
        )
      expect(await request()).toBe(error)
      expect(mockEmail).not.toHaveBeenCalled()
      expect(consumeLimiter).toHaveBeenCalledTimes(refused)
      assertPrivateTelemetryAbsent()
    },
  )
  it("returns the exact email-provider refusal without serializing it", async () => {
    const error = new Error("PRIVATE_EMAIL_PROVIDER_ERROR")
    mockEmail.mockResolvedValue(error)
    expect(await request()).toBe(error)
    assertPrivateTelemetryAbsent()
  })
})
