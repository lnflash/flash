const mockInitiateVerify = jest.fn()
const mockIsPhoneCodeValid = jest.fn()
const mockFindUserById = jest.fn()
const mockUpdateUser = jest.fn()
const mockHasEmail = jest.fn()
const mockAddUnverifiedEmailToIdentity = jest.fn()
const mockSendEmailWithCode = jest.fn()
const mockValidateCode = jest.fn()
const mockAddPhoneToIdentity = jest.fn()

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
  }
})

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
  })),
  isPhoneCodeValid: (...args: unknown[]) => mockIsPhoneCodeValid(...args),
}))

jest.mock("@services/mongoose", () => ({
  UsersRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindUserById(...args),
    update: (...args: unknown[]) => mockUpdateUser(...args),
  })),
}))

jest.mock("@services/kratos", () => ({
  AuthWithEmailPasswordlessService: jest.fn(() => ({
    hasEmail: (...args: unknown[]) => mockHasEmail(...args),
    addUnverifiedEmailToIdentity: (...args: unknown[]) =>
      mockAddUnverifiedEmailToIdentity(...args),
    sendEmailWithCode: (...args: unknown[]) => mockSendEmailWithCode(...args),
    validateCode: (...args: unknown[]) => mockValidateCode(...args),
    addPhoneToIdentity: (...args: unknown[]) => mockAddPhoneToIdentity(...args),
  })),
}))

import { requestPhoneCodeForAuthedUser } from "@app/authentication/request-code"
import { verifyPhone } from "@app/authentication/phone"
import { addEmailToIdentity, verifyEmail } from "@app/authentication/email"
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
})
