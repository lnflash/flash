const mockInitiateVerify = jest.fn()
const mockGeetestValidate = jest.fn()
const mockSmsUnsupported = jest.fn(() => [] as string[])
const mockWhatsAppUnsupported = jest.fn(() => [] as string[])
const mockGetUserIdFromIdentifier = jest.fn()
const mockConsumeLimiter = jest.fn()
const mockRewardLimiter = jest.fn()

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
    getRequestCodeBlockedCountryPerIpLimits: jest.fn(() => ({
      points: 2,
      duration: 3600,
      blockDuration: 86400,
    })),
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
  consumeLimiter: (...args: unknown[]) => mockConsumeLimiter(...args),
  RedisRateLimitService: jest.fn(() => ({
    consume: jest.fn(async () => true),
    reset: jest.fn(async () => true),
    reward: (...args: unknown[]) => mockRewardLimiter(...args),
  })),
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
  IdentityRepository: jest.fn(() => ({
    getUserIdFromIdentifier: (...args: unknown[]) => mockGetUserIdFromIdentifier(...args),
  })),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  flushBlockedDestinationReports,
  requestPhoneCodeForAuthedUser,
  requestPhoneCodeWithCaptcha,
  resetBlockedDestinationReporting,
} from "@app/authentication/request-code"
import { IdentifierNotFoundError } from "@domain/authentication/errors"
import { PhoneCountryNotAllowedError } from "@domain/users/errors"
import { InvalidPhoneNumber } from "@domain/errors"
import { RateLimitPrefix } from "@domain/rate-limit"
import { UserCodeAttemptBlockedCountryIpRateLimiterExceededError } from "@domain/rate-limit/errors"
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
const TURKEY = "+905321234567"

class UnknownKratosError extends Error {}

// The blocked-country probe budget is a distinct bucket from the per-IP
// request-code budget; only the former is exhausted here.
const exhaustProbeBudget = () =>
  mockConsumeLimiter.mockImplementation(
    async ({ rateLimitConfig }: { rateLimitConfig: { key: string } }) =>
      rateLimitConfig.key === RateLimitPrefix.requestCodeBlockedCountryPerIp
        ? new UserCodeAttemptBlockedCountryIpRateLimiterExceededError()
        : true,
  )

const resetMocks = () => {
  jest.clearAllMocks()
  resetBlockedDestinationReporting()
  mockInitiateVerify.mockResolvedValue(true)
  mockSmsUnsupported.mockReturnValue([])
  mockWhatsAppUnsupported.mockReturnValue([])
  mockConsumeLimiter.mockImplementation(async () => true)
  mockRewardLimiter.mockResolvedValue(true)
  mockGetUserIdFromIdentifier.mockResolvedValue(new IdentifierNotFoundError())
}

describe("requestPhoneCodeWithCaptcha — destination country gate", () => {
  beforeEach(() => {
    resetMocks()
    mockGeetestValidate.mockResolvedValue(true)
  })

  afterAll(resetBlockedDestinationReporting)

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
    mockGetUserIdFromIdentifier.mockResolvedValue("user-id")

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({
      to: UZBEKISTAN,
      channel: "sms",
    })
  })

  // Whether a number can log in is decided by Kratos, and the Mongo user doc is
  // written afterwards by a webhook that can fail. Asking Mongo would refuse a
  // login code to an account that logs in fine today.
  it("still sends when Kratos knows the number and Mongo does not", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])
    // No Mongo user record exists at all — the identity is the only evidence.
    mockGetUserIdFromIdentifier.mockResolvedValue("kratos-only-user-id")

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(mockGetUserIdFromIdentifier).toHaveBeenCalledWith(UZBEKISTAN)
    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({
      to: UZBEKISTAN,
      channel: "sms",
    })
  })

  it("blocks a number Kratos has never seen", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])
    mockGetUserIdFromIdentifier.mockResolvedValue(new IdentifierNotFoundError())

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("fails closed when the identity lookup errors", async () => {
    mockSmsUnsupported.mockReturnValue(["UZ"])
    mockGetUserIdFromIdentifier.mockResolvedValue(new UnknownKratosError("kratos down"))

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  // The carve-out answers "does this number hold an account" for free, so it
  // needs a budget of its own — the per-IP request-code budget is far too
  // generous to bound an enumeration sweep that costs the attacker nothing.
  describe("existence-probe budget", () => {
    it("blocks an existing user's number once the probe budget is spent", async () => {
      mockSmsUnsupported.mockReturnValue(["UZ"])
      mockGetUserIdFromIdentifier.mockResolvedValue("user-id")
      exhaustProbeBudget()

      const result = await requestCode(UZBEKISTAN, "sms")

      // Same response as any other blocked number: no oracle.
      expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
      expect(mockInitiateVerify).not.toHaveBeenCalled()
    })

    it("spends the budget before the lookup, so a sweep cannot probe past it", async () => {
      mockSmsUnsupported.mockReturnValue(["UZ"])
      exhaustProbeBudget()

      await requestCode(UZBEKISTAN, "sms")

      expect(mockConsumeLimiter).toHaveBeenCalledWith(
        expect.objectContaining({
          rateLimitConfig: expect.objectContaining({
            key: RateLimitPrefix.requestCodeBlockedCountryPerIp,
          }),
          keyToConsume: "1.2.3.4",
        }),
      )
      expect(mockGetUserIdFromIdentifier).not.toHaveBeenCalled()
    })

    it("reports a burnt-out probe budget as its own phase", async () => {
      mockSmsUnsupported.mockReturnValue(["UZ"])
      exhaustProbeBudget()

      await requestCode(UZBEKISTAN, "sms")

      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "destination-blocked-probe-limit" }),
      )
    })

    it("refunds the point for a confirmed account, so a real user is never spent out", async () => {
      mockSmsUnsupported.mockReturnValue(["UZ"])
      mockGetUserIdFromIdentifier.mockResolvedValue("user-id")

      await requestCode(UZBEKISTAN, "sms")

      expect(mockRewardLimiter).toHaveBeenCalledWith("1.2.3.4")
    })

    it("does not refund a number that holds no account", async () => {
      mockSmsUnsupported.mockReturnValue(["UZ"])

      await requestCode(UZBEKISTAN, "sms")

      expect(mockRewardLimiter).not.toHaveBeenCalled()
    })

    it("never touches the probe budget for a supported country", async () => {
      await requestCode(JAMAICA, "sms")

      expect(mockConsumeLimiter).not.toHaveBeenCalledWith(
        expect.objectContaining({
          rateLimitConfig: expect.objectContaining({
            key: RateLimitPrefix.requestCodeBlockedCountryPerIp,
          }),
        }),
      )
    })
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

    // The block list is meant to be tuned by watching this feed for real
    // traffic. If the carve-out — which is exactly the real users — reported
    // nothing, the feed could only ever say "no real users here".
    it("reports a carve-out so served real users are visible in the feed", async () => {
      mockSmsUnsupported.mockReturnValue(["UZ"])
      mockGetUserIdFromIdentifier.mockResolvedValue("user-id")

      await requestCode(UZBEKISTAN, "sms")

      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "destination-blocked-existing-user",
          status: "pending",
          phone: UZBEKISTAN,
          meta: expect.objectContaining({ country: "UZ", channel: "sms" }),
        }),
      )
    })

    // notifyOpsEvent feeds one 50-slot FIFO shared with cashout/deposit/etc.
    // that drops its OLDEST entries: an embed per rejection would evict the
    // rest of the ops feed during the very incident this telemetry is for.
    describe("coalescing", () => {
      it("pages immediately on the first rejection of a country", async () => {
        mockSmsUnsupported.mockReturnValue(["UZ"])

        await requestCode(UZBEKISTAN, "sms")

        expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      })

      it("emits nothing more for the rest of the window", async () => {
        mockSmsUnsupported.mockReturnValue(["UZ"])

        for (let i = 0; i < 20; i++) await requestCode(UZBEKISTAN, "sms")

        expect(baseLogger.warn).toHaveBeenCalledTimes(20)
        expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      })

      it("flushes the rest as one counted summary", async () => {
        mockSmsUnsupported.mockReturnValue(["UZ"])

        for (let i = 0; i < 20; i++) await requestCode(UZBEKISTAN, "sms")
        flushBlockedDestinationReports()

        expect(notifyOpsEvent).toHaveBeenCalledTimes(2)
        expect(notifyOpsEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            phase: "destination-blocked",
            meta: expect.objectContaining({ country: "UZ", count: "19" }),
          }),
        )
      })

      it("pages a new attack origin immediately even mid-flood", async () => {
        mockSmsUnsupported.mockReturnValue(["UZ", "TR"])

        for (let i = 0; i < 20; i++) await requestCode(UZBEKISTAN, "sms")
        ;(notifyOpsEvent as jest.Mock).mockClear()

        await requestCode(TURKEY, "sms")

        expect(notifyOpsEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: "destination-blocked",
            meta: expect.objectContaining({ country: "TR" }),
          }),
        )
      })

      it("counts each country separately", async () => {
        mockSmsUnsupported.mockReturnValue(["UZ", "TR"])

        for (let i = 0; i < 3; i++) await requestCode(UZBEKISTAN, "sms")
        for (let i = 0; i < 5; i++) await requestCode(TURKEY, "sms")
        ;(notifyOpsEvent as jest.Mock).mockClear()
        flushBlockedDestinationReports()

        const counts = (notifyOpsEvent as jest.Mock).mock.calls.map(
          ([event]) => `${event.meta.country}:${event.meta.count}`,
        )
        expect(counts.sort()).toEqual(["TR:4", "UZ:2"])
      })

      it("drains its pending summaries, so a flush emits nothing twice", async () => {
        mockSmsUnsupported.mockReturnValue(["UZ"])

        for (let i = 0; i < 3; i++) await requestCode(UZBEKISTAN, "sms")
        flushBlockedDestinationReports()
        ;(notifyOpsEvent as jest.Mock).mockClear()
        flushBlockedDestinationReports()

        expect(notifyOpsEvent).not.toHaveBeenCalled()
      })

      it("coalesces the carve-out on the same terms", async () => {
        mockSmsUnsupported.mockReturnValue(["UZ"])
        mockGetUserIdFromIdentifier.mockResolvedValue("user-id")

        for (let i = 0; i < 4; i++) await requestCode(UZBEKISTAN, "sms")
        expect(notifyOpsEvent).toHaveBeenCalledTimes(1)

        flushBlockedDestinationReports()

        expect(notifyOpsEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            phase: "destination-blocked-existing-user",
            status: "pending",
            meta: expect.objectContaining({ country: "UZ", count: "3" }),
          }),
        )
      })
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

  beforeEach(resetMocks)

  afterAll(resetBlockedDestinationReporting)

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
    mockGetUserIdFromIdentifier.mockResolvedValue("someone-else")

    const result = await requestForAuthedUser(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockGetUserIdFromIdentifier).not.toHaveBeenCalled()
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })
})
