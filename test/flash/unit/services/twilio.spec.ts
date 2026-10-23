/**
 * Every Twilio Verify send must carry the `global_sends` programmable
 * rate-limit key: Twilio only enforces the service-wide send cap (40/min,
 * 600/h, configured on the Verify service) for requests that name it. The
 * 2026-09-02 09:04Z probe (392 OTP requests in one minute from 364 IPs) is
 * the shape this cap exists for.
 */
const verificationsCreate = jest.fn()
const verificationChecksCreate = jest.fn()
const lookupPhoneNumbers = jest.fn()
const lookupFetch = jest.fn()

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
    lookups: { v1: { phoneNumbers: lookupPhoneNumbers } },
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
  PhoneCodeInvalidError,
  PhoneProviderRateLimitExceededError,
  RestrictedRegionPhoneProviderError,
  UnknownPhoneProviderServiceError,
} from "@domain/phone-provider"

const phone = "+18765550100" as PhoneNumber
const mockedLogger = baseLogger as unknown as { warn: jest.Mock; error: jest.Mock }

// Shape of the twilio SDK's RestException on a 429.
const rateLimitRejection = () =>
  Object.assign(new Error("Max send attempts reached"), { status: 429, code: 60203 })

describe("TwilioClient.initiateVerify", () => {
  beforeEach(() => {
    verificationsCreate.mockReset()
    verificationChecksCreate.mockReset()
    lookupPhoneNumbers.mockReset()
    lookupFetch.mockReset()
    lookupPhoneNumbers.mockReturnValue({ fetch: lookupFetch })
    mockedLogger.warn.mockReset()
    mockedLogger.error.mockReset()
    jest.mocked(baseLogger.info).mockReset()
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

  it("maps an exhausted bucket (HTTP 429 / 60203) to the rate-limit error without logging the number", async () => {
    verificationsCreate.mockRejectedValue(rateLimitRejection())

    const result = await TwilioClient().initiateVerify({ to: phone, channel: "sms" })

    expect(result).toBeInstanceOf(PhoneProviderRateLimitExceededError)
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      { operation: "twilio_verify_send", outcome: "rate_limited", channel: "sms" },
      "verify send rejected with HTTP 429 (rate limit, cause unconfirmed — not necessarily the global send cap)",
    )
    expect(mockedLogger.error).not.toHaveBeenCalled()
    expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toContain(phone)
  })

  it("does NOT attribute a 60203 rejection to the global_sends cap, since Twilio's built-in per-number Verify limit returns the identical code", async () => {
    // 60203 ("Max send attempts reached") is Twilio's answer for BOTH the
    // built-in per-number Verify limit (a normal user mashing "resend
    // code") and the programmable global_sends cap (an actual attack).
    // There is no field in the error that tells them apart, so the log
    // must never claim the global_sends key/cause just because code ===
    // 60203 — that would misdiagnose routine per-number throttling as the
    // attack-mitigation cap tripping.
    verificationsCreate.mockRejectedValue(rateLimitRejection())

    const result = await TwilioClient().initiateVerify({ to: phone, channel: "sms" })

    expect(result).toBeInstanceOf(PhoneProviderRateLimitExceededError)
    const [fields, message] = mockedLogger.warn.mock.calls[0]
    expect(fields).not.toHaveProperty("rateLimitKey")
    expect(message).not.toBe("verify send rejected by twilio rate limit")
  })

  it("still maps a 429 whose text drifts away from the known regex", async () => {
    verificationsCreate.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), { status: 429 }),
    )

    const result = await TwilioClient().initiateVerify({ to: phone, channel: "sms" })

    expect(result).toBeInstanceOf(PhoneProviderRateLimitExceededError)
  })

  it("does not attribute Twilio's unrelated concurrent-request throttle (429, non-60203) to the global_sends cap", async () => {
    // Twilio's "Too many concurrent requests" throttle also returns HTTP 429,
    // but with a different error code than the exhausted-bucket case (60203).
    // The log line must not claim the global_sends cap tripped, or an
    // on-call engineer grepping for it during a real concurrent-request
    // event will misdiagnose it as the send cap.
    verificationsCreate.mockRejectedValue(
      Object.assign(new Error("Too many concurrent requests"), {
        status: 429,
        code: 20429,
      }),
    )

    const result = await TwilioClient().initiateVerify({ to: phone, channel: "sms" })

    expect(result).toBeInstanceOf(PhoneProviderRateLimitExceededError)
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1)
    const [fields, message] = mockedLogger.warn.mock.calls[0]
    expect(fields).toEqual({
      operation: "twilio_verify_send",
      outcome: "rate_limited",
      channel: "sms",
    })
    expect(fields).not.toHaveProperty("rateLimitKey")
    expect(message).not.toBe("verify send rejected by twilio rate limit")
    expect(mockedLogger.error).not.toHaveBeenCalled()
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
      { operation: "twilio_verify_send", outcome: "failed" },
      "Unable to send verification code",
    )
    expect(
      KnownTwilioErrorMessages.RateLimitsExceeded.test("Max send attempts reached"),
    ).toBe(true)
  })

  it("classifies a private Verify send error without returning or logging provider text", async () => {
    const privateError = `The destination phone number has been blocked by Verify Geo-Permissions. SN is blocked for sms channel for all services; ${phone}`
    verificationsCreate.mockRejectedValue(new Error(privateError))

    const result = await TwilioClient().initiateVerify({ to: phone, channel: "sms" })

    expect(result).toBeInstanceOf(RestrictedRegionPhoneProviderError)
    expect((result as Error).message).toBe("Phone region is restricted")
    expect(JSON.stringify(mockedLogger.error.mock.calls)).not.toContain(phone)
    expect(JSON.stringify(result)).not.toContain(phone)
  })

  it("classifies a private Verify check error without returning or logging the code", async () => {
    const privateCode = "private-otp-602123"
    verificationChecksCreate.mockRejectedValue(
      new Error(`Invalid parameter: Code ${privateCode} for ${phone}`),
    )

    const result = await TwilioClient().validateVerify({
      to: phone,
      code: privateCode as PhoneCode,
    })

    expect(verificationChecksCreate).toHaveBeenCalledWith({
      to: phone,
      code: privateCode,
    })
    expect(result).toBeInstanceOf(PhoneCodeInvalidError)
    expect((result as Error).message).toBe("Invalid verification code")
    const diagnostics = JSON.stringify({ result, logs: mockedLogger.error.mock.calls })
    expect(diagnostics).not.toContain(privateCode)
    expect(diagnostics).not.toContain(phone)
  })

  it("returns the exact carrier metadata without logging it or a raw lookup failure", async () => {
    const privateCarrier = "Private Carrier Account"
    const metadata = {
      countryCode: "JM",
      phoneNumber: phone,
      nationalFormat: "PRIVATE_NATIONAL_FORMAT",
      carrier: {
        error_code: null,
        mobile_country_code: "338",
        mobile_network_code: "050",
        name: privateCarrier,
        type: "mobile",
      },
    }
    lookupFetch.mockResolvedValueOnce(metadata)
    expect(await TwilioClient().getCarrier(phone)).toEqual({
      carrier: metadata.carrier,
      countryCode: "JM",
    })
    expect(lookupPhoneNumbers).toHaveBeenCalledWith(phone)
    expect(lookupFetch).toHaveBeenCalledWith({ type: ["carrier"] })
    expect(JSON.stringify(jest.mocked(baseLogger.info).mock.calls)).not.toContain(phone)
    expect(JSON.stringify(jest.mocked(baseLogger.info).mock.calls)).not.toContain(
      privateCarrier,
    )

    lookupFetch.mockRejectedValueOnce(new Error(`PRIVATE_PROVIDER_ERROR ${phone}`))
    const failure = await TwilioClient().getCarrier(phone)
    expect(failure).toBeInstanceOf(UnknownPhoneProviderServiceError)
    expect((failure as Error).message).toBe("Carrier lookup failed")
    expect(JSON.stringify(failure)).not.toContain(phone)
  })
})
