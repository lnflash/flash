/**
 * Every Twilio Verify send must carry the `global_sends` programmable
 * rate-limit key: Twilio only enforces the service-wide send cap (40/min,
 * 600/h, configured on the Verify service) for requests that name it. The
 * 2026-09-02 09:04Z probe (392 OTP requests in one minute from 364 IPs) is
 * the shape this cap exists for.
 */
const verificationsCreate = jest.fn()
const verificationChecksCreate = jest.fn()

jest.mock("twilio", () =>
  jest.fn(() => ({
    verify: {
      v2: {
        services: jest.fn(() => ({
          verifications: { create: verificationsCreate },
          verificationChecks: { create: verificationChecksCreate },
        })),
      },
    },
    lookups: { v1: { phoneNumbers: jest.fn() } },
  })),
)

jest.mock("@config", () => ({
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_VERIFY_SERVICE_ID: "VAtest",
  UNSECURE_DEFAULT_LOGIN_CODE: "000000",
  getTestAccounts: () => [],
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({ fns }: { fns: unknown }) => fns,
}))

import { baseLogger } from "@services/logger"
import {
  KnownTwilioErrorMessages,
  TwilioClient,
  VERIFY_GLOBAL_SEND_CAP_KEY,
  VERIFY_GLOBAL_SEND_CAP_VALUE,
} from "@services/twilio"
import {
  PhoneProviderRateLimitExceededError,
  RestrictedRegionPhoneProviderError,
} from "@domain/phone-provider"

const phone = "+18765550100" as PhoneNumber
const mockedLogger = baseLogger as unknown as { warn: jest.Mock; error: jest.Mock }

// Shape of the twilio SDK's RestException on a 429.
const rateLimitRejection = () =>
  Object.assign(new Error("Max send attempts reached"), { status: 429, code: 60203 })

describe("TwilioClient.initiateVerify", () => {
  beforeEach(() => {
    verificationsCreate.mockReset()
    mockedLogger.warn.mockReset()
    mockedLogger.error.mockReset()
  })

  it.each(["sms", "whatsapp"] as ChannelType[])(
    "carries the global_sends rate-limit key on a %s send",
    async (channel) => {
      verificationsCreate.mockResolvedValue({ status: "pending" })

      const result = await TwilioClient().initiateVerify({ to: phone, channel })

      expect(result).toBe(true)
      expect(verificationsCreate).toHaveBeenCalledTimes(1)
      expect(verificationsCreate).toHaveBeenCalledWith({
        to: phone,
        channel,
        rateLimits: { [VERIFY_GLOBAL_SEND_CAP_KEY]: VERIFY_GLOBAL_SEND_CAP_VALUE },
      })
    },
  )

  it("uses a constant key value so the cap is service-wide, not per user", () => {
    expect(VERIFY_GLOBAL_SEND_CAP_KEY).toBe("global_sends")
    expect(VERIFY_GLOBAL_SEND_CAP_VALUE).toBe("all")
  })

  it("maps an exhausted bucket (HTTP 429 / 60203) to the rate-limit error and warns with a masked number", async () => {
    verificationsCreate.mockRejectedValue(rateLimitRejection())

    const result = await TwilioClient().initiateVerify({ to: phone, channel: "sms" })

    expect(result).toBeInstanceOf(PhoneProviderRateLimitExceededError)
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+1876…00",
        channel: "sms",
        twilioStatus: 429,
        twilioCode: 60203,
        rateLimitKey: "global_sends",
      }),
      "verify send rejected by twilio rate limit",
    )
    expect(mockedLogger.error).not.toHaveBeenCalled()
    expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toContain(phone)
  })

  it("still maps a 429 whose text drifts away from the known regex", async () => {
    verificationsCreate.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), { status: 429 }),
    )

    const result = await TwilioClient().initiateVerify({ to: phone, channel: "sms" })

    expect(result).toBeInstanceOf(PhoneProviderRateLimitExceededError)
  })

  it("keeps the existing message-based mapping for everything else", async () => {
    verificationsCreate.mockRejectedValue(
      Object.assign(
        new Error(
          "The destination phone number has been blocked by Verify Geo-Permissions. SN is blocked for sms channel for all services",
        ),
        { status: 403, code: 60605 },
      ),
    )

    const result = await TwilioClient().initiateVerify({ to: phone, channel: "sms" })

    expect(result).toBeInstanceOf(RestrictedRegionPhoneProviderError)
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "impossible to send text",
    )
    expect(
      KnownTwilioErrorMessages.RateLimitsExceeded.test("Max send attempts reached"),
    ).toBe(true)
  })
})
