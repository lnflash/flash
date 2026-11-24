import {
  loginWithDevice,
  loginWithEmailCookie,
  loginWithEmailToken,
  loginWithPhoneCookie,
  loginWithPhoneToken,
} from "@app/authentication/login"

import { IdentifierNotFoundError } from "@domain/authentication/errors"
import { CouldNotFindError, InactiveAccountError } from "@domain/errors"

import {
  AuthWithEmailPasswordlessService,
  AuthWithPhonePasswordlessService,
  AuthWithUsernamePasswordDeviceIdService,
  IdentityRepository,
} from "@services/kratos"
import { AccountsRepository } from "@services/mongoose"

jest.mock("@app/accounts/create-account", () => ({
  createAccountForDeviceAccount: jest.fn().mockResolvedValue({ id: "new-account" }),
}))

jest.mock("@services/ledger", () => ({ LedgerService: jest.fn() }))

jest.mock("@app/accounts", () => ({ upgradeAccountFromDeviceToPhone: jest.fn() }))

jest.mock("@services/twilio", () => ({
  isPhoneCodeValid: jest.fn().mockResolvedValue(true),
  TwilioClient: jest.fn(),
}))

jest.mock("@services/kratos", () => ({
  ...jest.requireActual("@services/kratos"),
  IdentityRepository: jest.fn(),
  AuthWithEmailPasswordlessService: jest.fn(),
  AuthWithPhonePasswordlessService: jest.fn(),
  AuthWithUsernamePasswordDeviceIdService: jest.fn(),
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(),
  WalletsRepository: jest.fn(),
}))

jest.mock("@app/wallets", () => ({ getBalanceForWallet: jest.fn() }))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/alerts/ops-events", () => ({ notifyOpsEvent: jest.fn() }))

jest.mock("@domain/accounts-ips/ip-metadata-authorizer", () => ({
  IPMetadataAuthorizer: jest.fn(),
}))

jest.mock("@services/ipfetcher", () => ({ IpFetcher: jest.fn() }))

jest.mock("@app/authentication/ratelimits", () => ({
  checkFailedLoginAttemptPerIpLimits: jest.fn().mockResolvedValue(true),
  checkFailedLoginAttemptPerLoginIdentifierLimits: jest.fn().mockResolvedValue(true),
  rewardFailedLoginAttemptPerIpLimits: jest.fn().mockResolvedValue(true),
  rewardFailedLoginAttemptPerLoginIdentifierLimits: jest.fn().mockResolvedValue(true),
}))

jest.mock("@config", () => ({
  getAccountsOnboardConfig: jest.fn(() => ({
    ipMetadataValidationSettings: { enabled: false },
  })),
}))

const USER_ID = "kratos-user-id" as UserId
const ip = "203.0.113.7" as IpAddress
const phone = "+18765550100" as PhoneNumber
const code = "000000" as PhoneCode
const emailFlowId = "flow-id" as EmailFlowId
const emailCode = "123456" as EmailCode
const device = {
  ip,
  username: "0f6c2b5e-9f8a-4c9a-b0a1-5a8e6f1d2c3b",
  password: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  deviceId: "0f6c2b5e-9f8a-4c9a-b0a1-5a8e6f1d2c3b",
}

describe("login refuses a locked account before any session is created", () => {
  let getUserIdFromIdentifier: jest.Mock
  let findByUserId: jest.Mock
  const phoneAuth = {
    loginToken: jest.fn(),
    loginCookie: jest.fn(),
    createIdentityWithSession: jest.fn(),
    createIdentityWithCookie: jest.fn(),
  }
  const emailAuth = {
    validateCode: jest.fn(),
    isEmailVerified: jest.fn(),
    loginToken: jest.fn(),
    loginCookie: jest.fn(),
  }
  const deviceAuth = { createIdentityWithSession: jest.fn() }

  const sessionCalls = () => [
    phoneAuth.loginToken,
    phoneAuth.loginCookie,
    emailAuth.loginToken,
    emailAuth.loginCookie,
    deviceAuth.createIdentityWithSession,
  ]

  const paths: [string, () => Promise<unknown>][] = [
    ["loginWithPhoneToken", () => loginWithPhoneToken({ phone, code, ip })],
    ["loginWithPhoneCookie", () => loginWithPhoneCookie({ phone, code, ip })],
    [
      "loginWithEmailToken",
      () => loginWithEmailToken({ emailFlowId, code: emailCode, ip }),
    ],
    [
      "loginWithEmailCookie",
      () => loginWithEmailCookie({ emailFlowId, code: emailCode, ip }),
    ],
    ["loginWithDevice", () => loginWithDevice(device)],
  ]

  beforeEach(() => {
    jest.clearAllMocks()
    getUserIdFromIdentifier = jest.fn().mockResolvedValue(USER_ID)
    findByUserId = jest.fn().mockResolvedValue({ id: "account-id", status: "active" })
    ;(IdentityRepository as jest.Mock).mockReturnValue({ getUserIdFromIdentifier })
    ;(AccountsRepository as jest.Mock).mockReturnValue({ findByUserId })
    ;(AuthWithPhonePasswordlessService as jest.Mock).mockReturnValue(phoneAuth)
    ;(AuthWithEmailPasswordlessService as jest.Mock).mockReturnValue(emailAuth)
    ;(AuthWithUsernamePasswordDeviceIdService as jest.Mock).mockReturnValue(deviceAuth)

    phoneAuth.loginToken.mockResolvedValue({ authToken: "t", kratosUserId: USER_ID })
    phoneAuth.loginCookie.mockResolvedValue({ cookiesToSendBackToClient: [] })
    emailAuth.validateCode.mockResolvedValue({
      email: "user@example.com",
      totpRequired: false,
    })
    emailAuth.isEmailVerified.mockResolvedValue(true)
    emailAuth.loginToken.mockResolvedValue({ authToken: "t" })
    emailAuth.loginCookie.mockResolvedValue({ cookiesToSendBackToClient: [] })
    deviceAuth.createIdentityWithSession.mockResolvedValue({
      authToken: "t",
      kratosUserId: USER_ID,
      newEntity: false,
    })
  })

  it.each(paths)(
    "%s: a locked account gets InactiveAccountError and no session",
    async (_, login) => {
      findByUserId.mockResolvedValue({ id: "account-id", status: "locked" })

      const result = await login()

      expect(result).toBeInstanceOf(InactiveAccountError)
      expect(findByUserId).toHaveBeenCalledWith(USER_ID)
      for (const call of sessionCalls()) expect(call).not.toHaveBeenCalled()
    },
  )

  it.each(paths)("%s: an active account still logs in", async (_, login) => {
    const result = await login()

    expect(result).not.toBeInstanceOf(Error)
    expect(sessionCalls().filter((c) => c.mock.calls.length > 0)).toHaveLength(1)
  })

  it.each(paths)(
    "%s: an identity with no account yet is not refused",
    async (_, login) => {
      findByUserId.mockResolvedValue(new CouldNotFindError())

      expect(await login()).not.toBeInstanceOf(Error)
    },
  )

  it("loginWithDevice: a device Kratos has never seen signs up without an account lookup", async () => {
    getUserIdFromIdentifier.mockResolvedValue(new IdentifierNotFoundError())
    deviceAuth.createIdentityWithSession.mockResolvedValue({
      authToken: "t",
      kratosUserId: USER_ID,
      newEntity: true,
    })

    expect(await loginWithDevice(device)).toBe("t")
    expect(findByUserId).not.toHaveBeenCalled()
  })

  it("a failed account lookup refuses the login instead of letting it through", async () => {
    const down = new Error("mongo down")
    findByUserId.mockResolvedValue(down)

    expect(await loginWithPhoneToken({ phone, code, ip })).toBe(down)
    expect(phoneAuth.loginToken).not.toHaveBeenCalled()
  })
})
