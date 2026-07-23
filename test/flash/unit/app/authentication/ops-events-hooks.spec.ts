const mockInitiateVerify = jest.fn()
const mockIsPhoneCodeValid = jest.fn()
const mockFindUserById = jest.fn()
const mockUpdateUser = jest.fn()
const mockHasEmail = jest.fn()
const mockAddUnverifiedEmailToIdentity = jest.fn()
const mockSendEmailWithCode = jest.fn()
const mockValidateCode = jest.fn()
const mockAddPhoneToIdentity = jest.fn()
const mockGetCarrier = jest.fn()
const mockGetUserIdFromIdentifier = jest.fn()
const mockUpgradeToPhoneSchema = jest.fn()
const mockListWalletsByAccountId = jest.fn()
const mockGetBalanceForWallet = jest.fn()
const mockUpgradeAccountFromDeviceToPhone = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@config", () => {
  const limits = { points: 100, duration: 60, blockDuration: 60 }
  return {
    TWILIO_ACCOUNT_SID: "AC-live",
    UNSECURE_DEFAULT_LOGIN_CODE: undefined,
    getGeetestConfig: jest.fn(() => ({})),
    getTestAccounts: jest.fn(() => []),
    getFailedLoginAttemptPerIpLimits: jest.fn(() => limits),
    getFailedLoginAttemptPerLoginIdentifierLimits: jest.fn(() => limits),
    getInvoiceCreateAttemptLimits: jest.fn(() => limits),
    getInvoiceCreateForRecipientAttemptLimits: jest.fn(() => limits),
    getOnChainAddressCreateAttemptLimits: jest.fn(() => limits),
    getRequestCodePerIpLimits: jest.fn(() => limits),
    getRequestCodePerLoginIdentifierLimits: jest.fn(() => limits),
    getAccountsOnboardConfig: jest.fn(() => ({
      phoneMetadataValidationSettings: { enabled: false },
      ipMetadataValidationSettings: { enabled: false },
    })),
  }
})

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/ipfetcher", () => ({
  IpFetcher: jest.fn(() => ({ fetchIPInfo: jest.fn() })),
}))

jest.mock("@app/accounts", () => ({
  upgradeAccountFromDeviceToPhone: (...args: unknown[]) =>
    mockUpgradeAccountFromDeviceToPhone(...args),
}))

jest.mock("@app/accounts/create-account", () => ({
  createAccountForDeviceAccount: jest.fn(),
}))

jest.mock("@app/wallets", () => ({
  getBalanceForWallet: (...args: unknown[]) => mockGetBalanceForWallet(...args),
}))

jest.mock("@services/geetest", () => ({
  __esModule: true,
  default: jest.fn(() => ({ validate: jest.fn() })),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/rate-limit", () => ({
  consumeLimiter: jest.fn(async () => true),
}))

jest.mock("@app/authentication/ratelimits", () => ({
  checkFailedLoginAttemptPerIpLimits: jest.fn(async () => true),
  checkFailedLoginAttemptPerLoginIdentifierLimits: jest.fn(async () => true),
  rewardFailedLoginAttemptPerIpLimits: jest.fn(async () => true),
  rewardFailedLoginAttemptPerLoginIdentifierLimits: jest.fn(async () => true),
}))

jest.mock("@services/twilio", () => ({
  TWILIO_ACCOUNT_TEST: "AC-test",
  TwilioClient: jest.fn(() => ({
    initiateVerify: (...args: unknown[]) => mockInitiateVerify(...args),
    getCarrier: (...args: unknown[]) => mockGetCarrier(...args),
  })),
  isPhoneCodeValid: (...args: unknown[]) => mockIsPhoneCodeValid(...args),
}))

jest.mock("@services/mongoose", () => ({
  UsersRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindUserById(...args),
    update: (...args: unknown[]) => mockUpdateUser(...args),
  })),
  WalletsRepository: jest.fn(() => ({
    listByAccountId: (...args: unknown[]) => mockListWalletsByAccountId(...args),
  })),
}))

jest.mock("@services/kratos", () => {
  class PhoneAccountAlreadyExistsNeedToSweepFundsError extends Error {}
  class PhoneAccountAlreadyExistsCannotUpgradeError extends Error {}
  return {
    PhoneAccountAlreadyExistsNeedToSweepFundsError,
    PhoneAccountAlreadyExistsCannotUpgradeError,
    AuthWithEmailPasswordlessService: jest.fn(() => ({
      hasEmail: (...args: unknown[]) => mockHasEmail(...args),
      addUnverifiedEmailToIdentity: (...args: unknown[]) =>
        mockAddUnverifiedEmailToIdentity(...args),
      sendEmailWithCode: (...args: unknown[]) => mockSendEmailWithCode(...args),
      validateCode: (...args: unknown[]) => mockValidateCode(...args),
      addPhoneToIdentity: (...args: unknown[]) => mockAddPhoneToIdentity(...args),
    })),
    AuthWithPhonePasswordlessService: jest.fn(() => ({})),
    AuthWithUsernamePasswordDeviceIdService: jest.fn(() => ({
      upgradeToPhoneSchema: (...args: unknown[]) => mockUpgradeToPhoneSchema(...args),
    })),
    IdentityRepository: jest.fn(() => ({
      getUserIdFromIdentifier: (...args: unknown[]) =>
        mockGetUserIdFromIdentifier(...args),
    })),
  }
})

import { requestPhoneCodeForAuthedUser } from "@app/authentication/request-code"
import { verifyPhone } from "@app/authentication/phone"
import { addEmailToIdentity, verifyEmail } from "@app/authentication/email"
import { loginDeviceUpgradeWithPhone } from "@app/authentication/login"
import { IdentifierNotFoundError } from "@domain/authentication/errors"
import { notifyOpsEvent } from "@services/alerts/ops-events"

class PhoneCodeInvalidError extends Error {}
class KratosBoomError extends Error {}

const userId = "11111111-1111-4111-8111-111111111111" as UserId
const phone = "+18765550100" as PhoneNumber
const email = "jabari@example.com" as EmailAddress
const ip = "127.0.0.1" as IpAddress

describe("ops events — verification funnel hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("requestPhoneCodeForAuthedUser", () => {
    const user = { id: userId, phone: undefined } as unknown as User

    it("notifies otp-sent after Twilio initiateVerify succeeds", async () => {
      mockInitiateVerify.mockResolvedValue(true)

      const result = await requestPhoneCodeForAuthedUser({
        phone,
        ip,
        channel: "sms" as ChannelType,
        user,
      })

      expect(result).toBe(true)
      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "otp-sent",
          status: "pending",
          userId,
          phone,
        }),
      )
    })

    it("does not notify when initiateVerify fails", async () => {
      const twilioError = new Error("twilio down")
      mockInitiateVerify.mockResolvedValue(twilioError)

      const result = await requestPhoneCodeForAuthedUser({
        phone,
        ip,
        channel: "sms" as ChannelType,
        user,
      })

      expect(result).toBe(twilioError)
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })
  })

  describe("verifyPhone", () => {
    it("notifies otp-verified on success", async () => {
      mockIsPhoneCodeValid.mockResolvedValue(true)
      const user = { id: userId, phone: undefined }
      mockFindUserById.mockResolvedValue(user)
      mockUpdateUser.mockResolvedValue({ ...user, phone })
      mockAddPhoneToIdentity.mockResolvedValue({})

      const result = await verifyPhone({ userId, phone, code: "123456" as PhoneCode, ip })

      expect(result).not.toBeInstanceOf(Error)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "otp-verified",
          status: "success",
          userId,
          phone,
        }),
      )
    })

    it("notifies otp-failed with the error name on failure", async () => {
      mockIsPhoneCodeValid.mockResolvedValue(new PhoneCodeInvalidError("bad code"))

      const result = await verifyPhone({ userId, phone, code: "000000" as PhoneCode, ip })

      expect(result).toBeInstanceOf(PhoneCodeInvalidError)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "otp-failed",
          status: "failed",
          userId,
          phone,
          error: "PhoneCodeInvalidError",
        }),
      )
    })
  })

  describe("addEmailToIdentity", () => {
    it("notifies otp-sent after the email code is sent", async () => {
      mockHasEmail.mockResolvedValue(false)
      mockAddUnverifiedEmailToIdentity.mockResolvedValue({})
      mockSendEmailWithCode.mockResolvedValue("flow-123" as EmailRegistrationId)
      mockFindUserById.mockResolvedValue({ id: userId })

      const result = await addEmailToIdentity({ email, userId })

      expect(result).not.toBeInstanceOf(Error)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "otp-sent",
          status: "pending",
          userId,
          email,
        }),
      )
    })

    it("does not notify when sending the code fails", async () => {
      mockHasEmail.mockResolvedValue(false)
      mockAddUnverifiedEmailToIdentity.mockResolvedValue({})
      mockSendEmailWithCode.mockResolvedValue(new KratosBoomError("smtp down"))

      const result = await addEmailToIdentity({ email, userId })

      expect(result).toBeInstanceOf(KratosBoomError)
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })
  })

  describe("verifyEmail", () => {
    const emailRegistrationId = "flow-123" as EmailRegistrationId

    it("notifies otp-verified on success", async () => {
      mockValidateCode.mockResolvedValue({
        kratosUserId: userId,
        email,
        totpRequired: false,
      })
      mockFindUserById.mockResolvedValue({ id: userId })

      const result = await verifyEmail({
        emailRegistrationId,
        code: "123456" as EmailCode,
      })

      expect(result).not.toBeInstanceOf(Error)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "otp-verified",
          status: "success",
          userId,
          email,
          meta: { emailFlowId: emailRegistrationId },
        }),
      )
    })

    it("notifies otp-failed with the error name on failure", async () => {
      mockValidateCode.mockResolvedValue(new KratosBoomError("bad code"))

      const result = await verifyEmail({
        emailRegistrationId,
        code: "000000" as EmailCode,
      })

      expect(result).toBeInstanceOf(KratosBoomError)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "otp-failed",
          status: "failed",
          error: "KratosBoomError",
          meta: { emailFlowId: emailRegistrationId },
        }),
      )
    })
  })

  describe("loginDeviceUpgradeWithPhone", () => {
    const accountId = "64df1a2b3c4d5e6f78901234" as AccountId
    const account = { id: accountId, kratosUserId: userId } as unknown as Account
    const args = { phone, code: "123456" as PhoneCode, ip, account }

    beforeEach(() => {
      mockIsPhoneCodeValid.mockResolvedValue(true)
      mockGetCarrier.mockResolvedValue(new Error("carrier lookup disabled"))
      mockUpgradeToPhoneSchema.mockResolvedValue(true)
      mockUpgradeAccountFromDeviceToPhone.mockResolvedValue({ id: accountId })
    })

    it("notifies upgrade-collision when the device account still has balance", async () => {
      mockGetUserIdFromIdentifier.mockResolvedValue("existing-user-id")
      mockListWalletsByAccountId.mockResolvedValue([
        { id: "w1", currency: "USD" },
        { id: "w2", currency: "USD" },
      ])
      mockGetBalanceForWallet
        .mockResolvedValueOnce({ isZero: () => true })
        .mockResolvedValueOnce({ isZero: () => false })

      const result = await loginDeviceUpgradeWithPhone(args)

      expect(result).toBeInstanceOf(Error)
      expect((result as Error).constructor.name).toBe(
        "PhoneAccountAlreadyExistsNeedToSweepFundsError",
      )
      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "upgrade-collision",
          status: "failed",
          accountId,
          userId,
          phone,
          error: "PhoneAccountAlreadyExistsNeedToSweepFundsError",
          meta: { deviceHasBalance: "true" },
        }),
      )
    })

    it("notifies upgrade-collision when the device account has zero balance", async () => {
      mockGetUserIdFromIdentifier.mockResolvedValue("existing-user-id")
      mockListWalletsByAccountId.mockResolvedValue([{ id: "w1", currency: "USD" }])
      mockGetBalanceForWallet.mockResolvedValue({ isZero: () => true })

      const result = await loginDeviceUpgradeWithPhone(args)

      expect(result).toBeInstanceOf(Error)
      expect((result as Error).constructor.name).toBe(
        "PhoneAccountAlreadyExistsCannotUpgradeError",
      )
      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "upgrade-collision",
          status: "failed",
          accountId,
          userId,
          phone,
          error: "PhoneAccountAlreadyExistsCannotUpgradeError",
          meta: { deviceHasBalance: "false" },
        }),
      )
    })

    it("does not notify failure events on the successful upgrade path", async () => {
      // The promotion event itself is emitted inside
      // upgradeAccountFromDeviceToPhone (mocked here; covered by the
      // accounts ops-events spec) — this function must add nothing else.
      mockGetUserIdFromIdentifier.mockResolvedValue(new IdentifierNotFoundError())

      const result = await loginDeviceUpgradeWithPhone(args)

      expect(result).toEqual({ success: true })
      expect(mockUpgradeAccountFromDeviceToPhone).toHaveBeenCalled()
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })

    it("notifies upgrade-failed when the OTP is invalid", async () => {
      mockIsPhoneCodeValid.mockResolvedValue(new PhoneCodeInvalidError("bad code"))

      const result = await loginDeviceUpgradeWithPhone(args)

      expect(result).toBeInstanceOf(PhoneCodeInvalidError)
      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "upgrade-failed",
          status: "failed",
          accountId,
          userId,
          phone,
          error: "PhoneCodeInvalidError",
        }),
      )
    })

    it("notifies upgrade-failed when the kratos schema upgrade fails", async () => {
      mockGetUserIdFromIdentifier.mockResolvedValue(new IdentifierNotFoundError())
      mockUpgradeToPhoneSchema.mockResolvedValue(new KratosBoomError("kratos down"))

      const result = await loginDeviceUpgradeWithPhone(args)

      expect(result).toBeInstanceOf(KratosBoomError)
      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "upgrade-failed",
          status: "failed",
          error: "KratosBoomError",
        }),
      )
    })
  })
})
