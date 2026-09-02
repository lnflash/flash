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
  resolvePhoneCountries,
} from "@app/bridge/kyc-gate"
import {
  BridgeKycCountryNotSupportedError,
  BridgeKycEmailNotVerifiedError,
  BridgeKycPhoneRequiredError,
} from "@services/bridge/errors"

const ALLOWED = new Set(["JM", "US", "GB"])

// +1 924 is an assigned, in-service US overlay that the pinned
// libphonenumber-js metadata (1.13.11) has no region for; +7 000 is a +7
// number no RU/KZ pattern claims. Both parse, neither has a `country`.
const UNATTRIBUTABLE_US = "+19245551234" as PhoneNumber
const UNATTRIBUTABLE_RU_KZ = "+70005551234" as PhoneNumber

const config = (
  overrides: Partial<{
    requireVerifiedEmail: boolean
    enabled: boolean
    source: BridgeKycCountryAllowlistSource
  }> = {},
): BridgeKycGateConfig => ({
  requireVerifiedEmail: overrides.requireVerifiedEmail ?? false,
  countryAllowlist: {
    enabled: overrides.enabled ?? true,
    source: overrides.source ?? "config",
    defaultCountries: ["JM"],
  },
})

const gate = (
  overrides: Partial<{
    emailVerified: boolean | undefined
    phoneCountries: string[]
    allowed: Set<string>
    requireVerifiedEmail: boolean
    enabled: boolean
  }> = {},
) =>
  checkBridgeKycEligibility({
    identity: {
      emailVerified: "emailVerified" in overrides ? overrides.emailVerified : true,
    },
    phoneCountries: overrides.phoneCountries ?? ["JM"],
    allowedCountries: overrides.allowed ?? ALLOWED,
    config: config(overrides),
  })

describe("resolvePhoneCountries", () => {
  it("prefers the Twilio Lookup country stamped at signup", () => {
    expect(
      resolvePhoneCountries({
        phoneMetadata: { countryCode: "jm" } as PhoneMetadata,
        phone: "+12125551234" as PhoneNumber,
      }),
    ).toEqual({ countries: ["JM"], source: "lookup" })
  })

  it("falls back to parsing the phone number when lookup metadata is missing", () => {
    expect(
      resolvePhoneCountries({
        phoneMetadata: undefined,
        phone: "+442071234567" as PhoneNumber,
      }),
    ).toEqual({ countries: ["GB"], source: "number" })
  })

  it("ignores a malformed lookup country and parses the number instead", () => {
    expect(
      resolvePhoneCountries({
        phoneMetadata: { countryCode: "" } as PhoneMetadata,
        phone: "+919876543210" as PhoneNumber,
      }),
    ).toEqual({ countries: ["IN"], source: "number" })
  })

  it("resolves a number the metadata cannot attribute to every region on its calling code", () => {
    const resolution = resolvePhoneCountries({
      phoneMetadata: undefined,
      phone: UNATTRIBUTABLE_US,
    })

    expect(resolution.source).toBe("calling-code")
    expect(resolution.callingCode).toBe("1")
    expect(resolution.countries).toEqual(expect.arrayContaining(["US", "PR", "JM"]))
    for (const code of resolution.countries) expect(code).toMatch(/^[A-Z]{2}$/)
  })

  it("keeps a shared non-NANP calling code as its candidate set too", () => {
    const resolution = resolvePhoneCountries({
      phoneMetadata: undefined,
      phone: UNATTRIBUTABLE_RU_KZ,
    })

    expect(resolution.source).toBe("calling-code")
    expect(resolution.callingCode).toBe("7")
    expect([...resolution.countries].sort()).toEqual(["KZ", "RU"])
  })

  it("resolves nothing when there is no phone at all (device account)", () => {
    expect(resolvePhoneCountries({ phoneMetadata: undefined, phone: undefined })).toEqual(
      { countries: [], source: "none" },
    )
    expect(resolvePhoneCountries(undefined)).toEqual({ countries: [], source: "none" })
  })

  it("resolves nothing for an unparsable number", () => {
    expect(
      resolvePhoneCountries({
        phoneMetadata: undefined,
        phone: "not-a-phone" as PhoneNumber,
      }),
    ).toEqual({ countries: [], source: "none" })
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
      const err = gate({ phoneCountries: ["IN"] })
      expect(err).toBeInstanceOf(BridgeKycCountryNotSupportedError)
      expect((err as BridgeKycCountryNotSupportedError).countryCode).toBe("IN")
      expect((err as BridgeKycCountryNotSupportedError).message).toBe(
        "US virtual accounts aren't available in India yet.",
      )
    })

    it("falls back to the code in the message when the country cannot be named", () => {
      const err = gate({ phoneCountries: ["ZZ"] }) as BridgeKycCountryNotSupportedError
      expect(err.message).toBe("US virtual accounts aren't available in ZZ yet.")
    })

    it("is case-insensitive on the resolved country", () => {
      expect(gate({ phoneCountries: ["jm"] })).toBe(true)
    })

    it("rejects when no phone country can be resolved", () => {
      expect(gate({ phoneCountries: [] })).toBeInstanceOf(BridgeKycPhoneRequiredError)
      expect((gate({ phoneCountries: [] }) as Error).message).toBe(
        "Add and verify a phone number before starting identity verification.",
      )
    })

    // The unattributable-+1 case: the candidate set is every NANP region, and
    // one allowed member (US) is enough. Denying here would refuse a real US
    // user with a verified phone, and tell them to add one.
    it("passes a candidate set when any member is allowed", () => {
      expect(gate({ phoneCountries: ["DO", "PR", "US", "CA"] })).toBe(true)
      expect(gate({ phoneCountries: ["kz", "ru", "gb"] })).toBe(true)
    })

    it("denies a candidate set with no allowed member, naming the candidates", () => {
      const err = gate({ phoneCountries: ["KZ", "RU"] })
      expect(err).toBeInstanceOf(BridgeKycCountryNotSupportedError)
      expect((err as BridgeKycCountryNotSupportedError).countryCode).toBe("KZ/RU")
      expect((err as BridgeKycCountryNotSupportedError).message).toBe(
        "US virtual accounts aren't available in Kazakhstan or Russia yet.",
      )
    })

    it("uses the generic wording for a long denied candidate set", () => {
      const err = gate({
        phoneCountries: ["AG", "AI", "AS", "BB"],
        allowed: new Set(["JM"]),
      }) as BridgeKycCountryNotSupportedError
      expect(err.countryCode).toBe("AG/AI/AS/BB")
      expect(err.message).toBe(
        "US virtual accounts aren't available in your country yet.",
      )
    })

    it("denies by default: an empty allowlist admits nobody", () => {
      expect(gate({ allowed: new Set() })).toBeInstanceOf(
        BridgeKycCountryNotSupportedError,
      )
      expect(gate({ allowed: new Set(), phoneCountries: ["US", "CA"] })).toBeInstanceOf(
        BridgeKycCountryNotSupportedError,
      )
    })

    it("ignores the country (and a missing phone) when the rule is disabled", () => {
      expect(gate({ phoneCountries: ["IN"], enabled: false })).toBe(true)
      expect(gate({ phoneCountries: [], enabled: false })).toBe(true)
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
      gate({ emailVerified: false, requireVerifiedEmail: true, phoneCountries: ["IN"] }),
    ).toBeInstanceOf(BridgeKycEmailNotVerifiedError)
  })

  it("passes when both rules are disabled regardless of state", () => {
    expect(
      gate({
        emailVerified: false,
        requireVerifiedEmail: false,
        phoneCountries: [],
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
    expect(mockGetAllowedCountries).toHaveBeenCalledWith({
      source: "config",
      fallback: ["JM"],
    })
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it("hands the configured allowlist source to the reader", async () => {
    await assertBridgeKycEligible({
      account,
      user: jamaicanUser,
      config: config({ source: "erpnext" }),
    })

    expect(mockGetAllowedCountries).toHaveBeenCalledWith({
      source: "erpnext",
      fallback: ["JM"],
    })
  })

  it("stamps where the phone country came from on every evaluation, denied or not", async () => {
    await assertBridgeKycEligible({ account, user: jamaicanUser, config: config() })

    expect(mockAddAttributes).toHaveBeenCalledWith({
      "bridge.kyc_gate.country_source": "lookup",
    })
  })

  it("denies, logs and stamps the span for a country that is not allowed", async () => {
    const user = {
      phoneMetadata: { countryCode: "NG" } as PhoneMetadata,
      phone: "+2348012345678" as PhoneNumber,
    }

    const result = await assertBridgeKycEligible({ account, user, config: config() })

    expect(result).toBeInstanceOf(BridgeKycCountryNotSupportedError)
    expect(mockWarn).toHaveBeenCalledWith(
      {
        accountId: "account-1",
        countryCode: "NG",
        countrySource: "lookup",
        rule: "country-not-supported",
      },
      "bridge kyc gate denied initiation",
    )
    expect(mockAddAttributes).toHaveBeenCalledWith({
      "bridge.kyc_gate.denied": true,
      "bridge.kyc_gate.rule": "country-not-supported",
      "bridge.kyc_gate.country": "NG",
    })
  })

  // The hole this closes: Twilio Lookup failed at signup (login.ts returns
  // undefined metadata when validation is off), the number is on one of the
  // ~340 NANP area codes the pinned metadata lacks, and the old gate answered
  // "add and verify a phone number" to a user who had done exactly that.
  it("passes a US number on an area code the metadata cannot attribute, via the calling code", async () => {
    const result = await assertBridgeKycEligible({
      account,
      user: { phoneMetadata: undefined, phone: UNATTRIBUTABLE_US },
      config: config(),
    })

    expect(result).toBe(true)
    expect(mockWarn).not.toHaveBeenCalled()
    expect(mockAddAttributes).toHaveBeenCalledWith({
      "bridge.kyc_gate.country_source": "calling-code",
    })
  })

  it("denies an unattributable number on a calling code with no allowed region, labelled by that code", async () => {
    const result = await assertBridgeKycEligible({
      account,
      user: { phoneMetadata: undefined, phone: UNATTRIBUTABLE_RU_KZ },
      config: config(),
    })

    expect(result).toBeInstanceOf(BridgeKycCountryNotSupportedError)
    expect(mockWarn).toHaveBeenCalledWith(
      {
        accountId: "account-1",
        countryCode: "+7",
        countrySource: "calling-code",
        rule: "country-not-supported",
      },
      "bridge kyc gate denied initiation",
    )
    expect(mockAddAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ "bridge.kyc_gate.country": "+7" }),
    )
  })

  it("denies a user with no resolvable phone country", async () => {
    const result = await assertBridgeKycEligible({
      account,
      user: { phoneMetadata: undefined, phone: undefined },
      config: config(),
    })

    expect(result).toBeInstanceOf(BridgeKycPhoneRequiredError)
    expect(mockAddAttributes).toHaveBeenCalledWith({
      "bridge.kyc_gate.country_source": "none",
    })
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
