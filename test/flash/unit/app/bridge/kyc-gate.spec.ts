const mockGetIdentity = jest.fn()
const mockGetAllowedCountries = jest.fn()
const mockAddAttributes = jest.fn()
const mockWarn = jest.fn()

jest.mock("@services/kratos", () => ({
  IdentityRepository: () => ({
    getIdentity: (...args: unknown[]) => mockGetIdentity(...args),
  }),
}))

jest.mock("@services/frappe/allowed-countries", () => ({
  getAllowedCountries: (...args: unknown[]) => mockGetAllowedCountries(...args),
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: (...args: unknown[]) => mockAddAttributes(...args),
}))

jest.mock("@services/logger", () => ({
  baseLogger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  },
}))

import {
  assertBridgeKycEligible,
  checkBridgeKycEligibility,
  countryDisplayName,
  resolvePhoneCountry,
} from "@app/bridge/kyc-gate"
import {
  BridgeKycCountryNotSupportedError,
  BridgeKycEmailNotVerifiedError,
  BridgeKycPhoneRequiredError,
} from "@services/bridge/errors"

const ALLOWED = new Set(["JM", "US", "GB"])

const config = (
  overrides: Partial<{ requireVerifiedEmail: boolean; enabled: boolean }> = {},
): BridgeKycGateConfig => ({
  requireVerifiedEmail: overrides.requireVerifiedEmail ?? false,
  countryAllowlist: {
    enabled: overrides.enabled ?? true,
    defaultCountries: ["JM"],
  },
})

const gate = (
  overrides: Partial<{
    emailVerified: boolean | undefined
    phoneCountry: string | undefined
    allowed: Set<string>
    requireVerifiedEmail: boolean
    enabled: boolean
  }> = {},
) =>
  checkBridgeKycEligibility({
    identity: {
      emailVerified: "emailVerified" in overrides ? overrides.emailVerified : true,
    },
    phoneCountry: "phoneCountry" in overrides ? overrides.phoneCountry : "JM",
    allowedCountries: overrides.allowed ?? ALLOWED,
    config: config(overrides),
  })

describe("resolvePhoneCountry", () => {
  it("prefers the Twilio Lookup country stamped at signup", () => {
    expect(
      resolvePhoneCountry({
        phoneMetadata: { countryCode: "jm" } as PhoneMetadata,
        phone: "+12125551234" as PhoneNumber,
      }),
    ).toBe("JM")
  })

  it("falls back to parsing the phone number when lookup metadata is missing", () => {
    expect(
      resolvePhoneCountry({
        phoneMetadata: undefined,
        phone: "+442071234567" as PhoneNumber,
      }),
    ).toBe("GB")
  })

  it("ignores a malformed lookup country and parses the number instead", () => {
    expect(
      resolvePhoneCountry({
        phoneMetadata: { countryCode: "" } as PhoneMetadata,
        phone: "+919876543210" as PhoneNumber,
      }),
    ).toBe("IN")
  })

  it("returns undefined when there is no phone at all (device account)", () => {
    expect(
      resolvePhoneCountry({ phoneMetadata: undefined, phone: undefined }),
    ).toBeUndefined()
    expect(resolvePhoneCountry(undefined)).toBeUndefined()
  })

  it("returns undefined for an unparsable number", () => {
    expect(
      resolvePhoneCountry({
        phoneMetadata: undefined,
        phone: "not-a-phone" as PhoneNumber,
      }),
    ).toBeUndefined()
  })
})

describe("countryDisplayName", () => {
  it("names a known country", () => {
    expect(countryDisplayName("SN")).toBe("Senegal")
  })

  it("is undefined for a code the runtime cannot name", () => {
    expect(countryDisplayName("ZZ")).toBeUndefined()
  })
})

describe("checkBridgeKycEligibility", () => {
  it("passes an allowed phone country", () => {
    expect(gate()).toBe(true)
  })

  describe("country allowlist rule", () => {
    it("rejects a phone country that is not allowed, naming the country", () => {
      const err = gate({ phoneCountry: "IN" })
      expect(err).toBeInstanceOf(BridgeKycCountryNotSupportedError)
      expect((err as BridgeKycCountryNotSupportedError).countryCode).toBe("IN")
      expect((err as BridgeKycCountryNotSupportedError).message).toBe(
        "US virtual accounts aren't available in India yet.",
      )
    })

    it("falls back to the code in the message when the country cannot be named", () => {
      const err = gate({ phoneCountry: "ZZ" }) as BridgeKycCountryNotSupportedError
      expect(err.message).toBe("US virtual accounts aren't available in ZZ yet.")
    })

    it("is case-insensitive on the resolved country", () => {
      expect(gate({ phoneCountry: "jm" })).toBe(true)
    })

    it("rejects when no phone country can be resolved", () => {
      expect(gate({ phoneCountry: undefined })).toBeInstanceOf(
        BridgeKycPhoneRequiredError,
      )
      expect((gate({ phoneCountry: undefined }) as Error).message).toBe(
        "Add and verify a phone number before starting identity verification.",
      )
    })

    it("denies by default: an empty allowlist admits nobody", () => {
      expect(gate({ allowed: new Set() })).toBeInstanceOf(
        BridgeKycCountryNotSupportedError,
      )
    })

    it("ignores the country (and a missing phone) when the rule is disabled", () => {
      expect(gate({ phoneCountry: "IN", enabled: false })).toBe(true)
      expect(gate({ phoneCountry: undefined, enabled: false })).toBe(true)
    })
  })

  describe("verified email rule", () => {
    it("is off by default", () => {
      expect(gate({ emailVerified: false })).toBe(true)
      expect(gate({ emailVerified: undefined })).toBe(true)
    })

    it("rejects an unverified email when enabled", () => {
      expect(gate({ emailVerified: false, requireVerifiedEmail: true })).toBeInstanceOf(
        BridgeKycEmailNotVerifiedError,
      )
    })

    it("rejects a phone-only identity (emailVerified undefined) when enabled", () => {
      expect(
        gate({ emailVerified: undefined, requireVerifiedEmail: true }),
      ).toBeInstanceOf(BridgeKycEmailNotVerifiedError)
    })

    it("passes a verified email when enabled", () => {
      expect(gate({ emailVerified: true, requireVerifiedEmail: true })).toBe(true)
    })

    it("carries a user-facing message", () => {
      const err = gate({
        emailVerified: false,
        requireVerifiedEmail: true,
      }) as BridgeKycEmailNotVerifiedError
      expect(err.message).toBe(
        "Verify your email address before starting identity verification.",
      )
    })
  })

  it("reports the email rule first when both fail", () => {
    expect(
      gate({ emailVerified: false, requireVerifiedEmail: true, phoneCountry: "IN" }),
    ).toBeInstanceOf(BridgeKycEmailNotVerifiedError)
  })

  it("passes when both rules are disabled regardless of state", () => {
    expect(
      gate({
        emailVerified: false,
        requireVerifiedEmail: false,
        phoneCountry: undefined,
        enabled: false,
      }),
    ).toBe(true)
  })
})

describe("assertBridgeKycEligible", () => {
  const account = {
    id: "account-1" as AccountId,
    kratosUserId: "kratos-user-1" as UserId,
  }
  const jamaicanUser = {
    phoneMetadata: { countryCode: "JM" } as PhoneMetadata,
    phone: "+18765550100" as PhoneNumber,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAllowedCountries.mockResolvedValue(ALLOWED)
    mockGetIdentity.mockResolvedValue({ emailVerified: true })
  })

  it("passes an allowed phone country without touching Kratos when the email rule is off", async () => {
    await expect(
      assertBridgeKycEligible({ account, user: jamaicanUser, config: config() }),
    ).resolves.toBe(true)
    expect(mockGetIdentity).not.toHaveBeenCalled()
    expect(mockGetAllowedCountries).toHaveBeenCalledWith({ fallback: ["JM"] })
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it("denies, logs and stamps the span for a country that is not allowed", async () => {
    const user = {
      phoneMetadata: { countryCode: "NG" } as PhoneMetadata,
      phone: "+2348012345678" as PhoneNumber,
    }

    const result = await assertBridgeKycEligible({ account, user, config: config() })

    expect(result).toBeInstanceOf(BridgeKycCountryNotSupportedError)
    expect(mockWarn).toHaveBeenCalledWith(
      { accountId: "account-1", countryCode: "NG", rule: "country-not-supported" },
      "bridge kyc gate denied initiation",
    )
    expect(mockAddAttributes).toHaveBeenCalledWith({
      "bridge.kyc_gate.denied": true,
      "bridge.kyc_gate.rule": "country-not-supported",
      "bridge.kyc_gate.country": "NG",
    })
  })

  it("denies a user with no resolvable phone country", async () => {
    const result = await assertBridgeKycEligible({
      account,
      user: { phoneMetadata: undefined, phone: undefined },
      config: config(),
    })

    expect(result).toBeInstanceOf(BridgeKycPhoneRequiredError)
    expect(mockAddAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "bridge.kyc_gate.rule": "phone-required",
        "bridge.kyc_gate.country": "unknown",
      }),
    )
  })

  it("loads the Kratos identity only when the email rule is on", async () => {
    mockGetIdentity.mockResolvedValue({ emailVerified: false })

    const result = await assertBridgeKycEligible({
      account,
      user: jamaicanUser,
      config: config({ requireVerifiedEmail: true }),
    })

    expect(result).toBeInstanceOf(BridgeKycEmailNotVerifiedError)
    expect(mockGetIdentity).toHaveBeenCalledWith("kratos-user-1")
  })

  it("returns, not throws, when the identity lookup fails", async () => {
    const lookupError = new Error("kratos down")
    mockGetIdentity.mockResolvedValue(lookupError)

    await expect(
      assertBridgeKycEligible({
        account,
        user: jamaicanUser,
        config: config({ requireVerifiedEmail: true }),
      }),
    ).resolves.toBe(lookupError)
    expect(mockGetAllowedCountries).not.toHaveBeenCalled()
  })

  it("does not read the allowlist when the country rule is disabled", async () => {
    await expect(
      assertBridgeKycEligible({
        account,
        user: { phoneMetadata: undefined, phone: undefined },
        config: config({ enabled: false }),
      }),
    ).resolves.toBe(true)
    expect(mockGetAllowedCountries).not.toHaveBeenCalled()
  })
})
