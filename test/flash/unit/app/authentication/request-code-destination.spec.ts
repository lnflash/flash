const mockInitiateVerify = jest.fn()
const mockGeetestValidate = jest.fn()
const mockSmsUnsupported = jest.fn(() => [] as string[])
const mockWhatsAppUnsupported = jest.fn(() => [] as string[])

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

import { requestPhoneCodeWithCaptcha } from "@app/authentication/request-code"
import { PhoneCountryNotAllowedError } from "@domain/users/errors"

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

describe("requestPhoneCodeWithCaptcha — destination country gate", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGeetestValidate.mockResolvedValue(true)
    mockInitiateVerify.mockResolvedValue(true)
    mockSmsUnsupported.mockReturnValue([])
    mockWhatsAppUnsupported.mockReturnValue([])
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

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("rejects before the provider even when the captcha passes", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])

    await requestCode(UZBEKISTAN, "sms")

    expect(mockGeetestValidate).toHaveBeenCalled()
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })
})
