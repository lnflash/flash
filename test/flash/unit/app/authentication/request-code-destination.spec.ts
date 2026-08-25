const mockInitiateVerify = jest.fn()
const mockGeetestValidate = jest.fn()
const mockSmsUnsupported = jest.fn(() => [] as string[])
const mockWhatsAppUnsupported = jest.fn(() => [] as string[])
const mockFindByPhone = jest.fn()

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
    getInviteCreateAttemptLimits: jest.fn(() => limits),
    getInviteTargetAttemptLimits: jest.fn(() => limits),
    getFygaroCheckoutCreateAttemptLimits: jest.fn(() => limits),
    getFygaroTopupAllowanceAttemptLimits: jest.fn(() => limits),
    getOnChainAddressCreateAttemptLimits: jest.fn(() => limits),
    getRequestCodePerIpLimits: jest.fn(() => limits),
    getRequestCodePerLoginIdentifierLimits: jest.fn(() => limits),
    getSmsAuthUnsupportedCountries: () => mockSmsUnsupported(),
    getWhatsAppAuthUnsupportedCountries: () => mockWhatsAppUnsupported(),
  }
})

jest.mock("@services/geetest", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    validate: (...args: unknown[]) => mockGeetestValidate(...args),
  })),
}))

jest.mock("@services/rate-limit", () => ({
  consumeLimiter: jest.fn(async () => true),
}))

jest.mock("@services/twilio", () => ({
  TWILIO_ACCOUNT_TEST: "AC-test",
  TwilioClient: jest.fn(() => ({
    initiateVerify: (...args: unknown[]) => mockInitiateVerify(...args),
  })),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/kratos", () => ({
  AuthWithEmailPasswordlessService: jest.fn(() => ({
    sendEmailWithCode: jest.fn(),
  })),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose", () => ({
  UsersRepository: jest.fn(() => ({
    findByPhone: (...args: unknown[]) => mockFindByPhone(...args),
  })),
}))

import {
  requestPhoneCodeForAuthedUser,
  requestPhoneCodeWithCaptcha,
} from "@app/authentication/request-code"
import { PhoneCountryNotAllowedError } from "@domain/users/errors"
import { InvalidPhoneNumber } from "@domain/errors"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { baseLogger } from "@services/logger"

const captcha = {
  geetestChallenge: "challenge",
  geetestValidate: "validate",
  geetestSeccode: "seccode",
}

const requestCode = (phone: string, channel: string) =>
  requestPhoneCodeWithCaptcha({
    phone: phone as PhoneNumber,
    ...captcha,
    ip: "1.2.3.4" as IpAddress,
    channel: channel as ChannelType,
  })

const JAMAICA = "+18761234567"
const UZBEKISTAN = "+998901234567"

class CouldNotFindUserFromPhoneError extends Error {}

describe("requestPhoneCodeWithCaptcha — destination country gate", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGeetestValidate.mockResolvedValue(true)
    mockInitiateVerify.mockResolvedValue(true)
    mockSmsUnsupported.mockReturnValue([])
    mockWhatsAppUnsupported.mockReturnValue([])
    mockFindByPhone.mockResolvedValue(new CouldNotFindUserFromPhoneError())
  })

  it("sends to a supported country", async () => {
    const result = await requestCode(JAMAICA, "sms")

    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({ to: JAMAICA, channel: "sms" })
  })

  it("never reaches the provider for an unsupported country", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("gates each channel against its own list", async () => {
    mockSmsUnsupported.mockReturnValue([])
    mockWhatsAppUnsupported.mockReturnValue(["UZ"])

    const viaWhatsApp = await requestCode(UZBEKISTAN, "whatsapp")
    expect(viaWhatsApp).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()

    const viaSms = await requestCode(UZBEKISTAN, "sms")
    expect(viaSms).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledTimes(1)
  })

  it("never reaches the provider for an unparseable number", async () => {
    const result = await requestCode("+000", "sms")

    expect(result).toBeInstanceOf(InvalidPhoneNumber)
    expect(result).not.toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("rejects before the provider even when the captcha passes", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])

    await requestCode(UZBEKISTAN, "sms")

    expect(mockGeetestValidate).toHaveBeenCalled()
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  // POST /auth/phone/code forwards req.body.channel verbatim ("SMS"/"WHATSAPP"),
  // unlike the GraphQL resolvers. Without normalization a WhatsApp request on
  // that route would be gated against the SMS list.
  it("normalizes the channel casing before picking a list", async () => {
    mockSmsUnsupported.mockReturnValue([])
    mockWhatsAppUnsupported.mockReturnValue(["UZ"])

    const result = await requestCode(UZBEKISTAN, "WHATSAPP")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("matches a lowercase configmap entry", async () => {
    mockSmsUnsupported.mockReturnValue(["uz"])

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  // A fraud control aimed at unregistered traffic must not permanently lock an
  // existing account out of its own login code.
  it("still sends to an existing user in a blocked country", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])
    mockFindByPhone.mockResolvedValue({ id: "user-id" })

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({
      to: UZBEKISTAN,
      channel: "sms",
    })
    expect(notifyOpsEvent).not.toHaveBeenCalled()
  })

  it("fails closed when the user lookup errors", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])
    mockFindByPhone.mockResolvedValue(new Error("mongo down"))

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  describe("telemetry", () => {
    it("logs and reports a blocked country", async () => {
      mockSmsUnsupported.mockReturnValue(["UZ"])

      await requestCode(UZBEKISTAN, "sms")

      expect(baseLogger.warn).toHaveBeenCalledWith(
        { countryCode: "UZ", channel: "sms" },
        "auth code destination blocked",
      )
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "destination-blocked",
          status: "failed",
          meta: expect.objectContaining({ country: "UZ", channel: "sms" }),
        }),
      )
    })

    it("reports an unparseable number as unknown, not as a blocked country", async () => {
      await requestCode("+000", "sms")

      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "destination-blocked",
          error: "InvalidPhoneNumber",
          meta: expect.objectContaining({ country: "unknown" }),
        }),
      )
    })

    it("stays silent when the destination is allowed", async () => {
      await requestCode(JAMAICA, "sms")

      expect(notifyOpsEvent).not.toHaveBeenCalled()
      expect(baseLogger.warn).not.toHaveBeenCalled()
    })
  })
})

describe("requestPhoneCodeForAuthedUser — destination country gate", () => {
  const user = { id: "user-id" as UserId, phone: undefined } as unknown as User

  const requestForAuthedUser = (phone: string, channel: string) =>
    requestPhoneCodeForAuthedUser({
      phone: phone as PhoneNumber,
      ip: "1.2.3.4" as IpAddress,
      channel: channel as ChannelType,
      user,
    })

  beforeEach(() => {
    jest.clearAllMocks()
    mockInitiateVerify.mockResolvedValue(true)
    mockSmsUnsupported.mockReturnValue([])
    mockWhatsAppUnsupported.mockReturnValue([])
    mockFindByPhone.mockResolvedValue(new CouldNotFindUserFromPhoneError())
  })

  it("sends to a supported country", async () => {
    const result = await requestForAuthedUser(JAMAICA, "sms")

    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({ to: JAMAICA, channel: "sms" })
  })

  it("never reaches the provider for an unsupported country", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])

    const result = await requestForAuthedUser(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("does not fire the otp-sent ops event for a blocked country", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])

    await requestForAuthedUser(UZBEKISTAN, "sms")

    expect(notifyOpsEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "otp-sent" }),
    )
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "destination-blocked" }),
    )
  })

  it("gates each channel against its own list", async () => {
    mockWhatsAppUnsupported.mockReturnValue(["UZ"])

    const viaWhatsApp = await requestForAuthedUser(UZBEKISTAN, "whatsapp")
    expect(viaWhatsApp).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()

    const viaSms = await requestForAuthedUser(UZBEKISTAN, "sms")
    expect(viaSms).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledTimes(1)
  })

  it("rejects an unparseable number as invalid", async () => {
    const result = await requestForAuthedUser("+000", "sms")

    expect(result).toBeInstanceOf(InvalidPhoneNumber)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  // Binding a phone to an authed account registers that number, so an existing
  // record for it must not open a hole in the gate.
  it("has no existing-user carve-out", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])
    mockFindByPhone.mockResolvedValue({ id: "someone-else" })

    const result = await requestForAuthedUser(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockFindByPhone).not.toHaveBeenCalled()
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })
})
