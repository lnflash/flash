const mockInitiateKyc = jest.fn()
const mockGetIdentity = jest.fn()
const mockGetAllowedCountries = jest.fn()

jest.mock("@services/bridge", () => ({
  __esModule: true,
  default: {
    initiateKyc: (...args: unknown[]) => mockInitiateKyc(...args),
  },
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: () => ({
    getIdentity: (...args: unknown[]) => mockGetIdentity(...args),
  }),
}))

jest.mock("@services/frappe/allowed-countries", () => ({
  getAllowedCountries: (...args: unknown[]) => mockGetAllowedCountries(...args),
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
}))

const GATE_DEFAULTS = () => ({
  requireVerifiedEmail: false,
  countryAllowlist: { enabled: true, defaultCountries: ["JM"] },
})

jest.mock("@config", () => ({
  BridgeConfig: {
    enabled: true,
    kycGate: {
      requireVerifiedEmail: false,
      countryAllowlist: { enabled: true, defaultCountries: ["JM"] },
    },
  },
  getOnChainWalletConfig: jest.fn().mockReturnValue({ dustThreshold: 546 }),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { BridgeConfig } from "@config"
import BridgeInitiateKycMutation from "@graphql/public/root/mutation/bridge-initiate-kyc"
import { UnknownKratosError } from "@services/kratos/errors"

// The mocked module object is mutable; tests reset it before each case.
const mockBridgeConfig = BridgeConfig as unknown as {
  enabled: boolean
  kycGate: BridgeKycGateConfig
}

const ACCOUNT_ID = "account-001" as AccountId
const KRATOS_USER_ID = "kratos-user-001" as UserId

type Result = {
  errors: Array<{ code?: string; message?: string }>
  kycLink?: unknown
}

const resolveWith = async (
  opts: {
    level?: number
    phoneCountry?: string | undefined
    phone?: string | undefined
  } = {},
): Promise<Result> => {
  // Explicit `undefined` must mean "no phone"; destructuring defaults would
  // silently put one back.
  const level = opts.level ?? 1
  const phoneCountry = "phoneCountry" in opts ? opts.phoneCountry : "JM"
  const phone = "phone" in opts ? opts.phone : "+18765550100"

  const resolve = BridgeInitiateKycMutation.resolve as unknown as (
    source: null,
    args: { input: Record<string, unknown> },
    context: unknown,
    info: never,
  ) => Promise<Result>

  return resolve(
    null,
    { input: { email: "user@example.com", type: "individual", full_name: "Test User" } },
    {
      domainAccount: {
        id: ACCOUNT_ID,
        level,
        kratosUserId: KRATOS_USER_ID,
      },
      user: {
        phoneMetadata: phoneCountry ? { countryCode: phoneCountry } : undefined,
        phone,
      },
    },
    {} as never,
  )
}

describe("bridgeInitiateKyc gate", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockBridgeConfig.enabled = true
    mockBridgeConfig.kycGate = GATE_DEFAULTS()
    mockGetIdentity.mockResolvedValue({ emailVerified: true })
    mockGetAllowedCountries.mockResolvedValue(new Set(["JM", "US"]))
    mockInitiateKyc.mockResolvedValue({ url: "https://bridge.example/kyc" })
  })

  it("calls Bridge for a level-1 account whose phone country is allowed", async () => {
    const result = await resolveWith()

    expect(result.errors).toEqual([])
    expect(result.kycLink).toEqual({ url: "https://bridge.example/kyc" })
    expect(mockGetAllowedCountries).toHaveBeenCalledWith({ fallback: ["JM"] })
    // Email rule is off by default: Kratos is not consulted.
    expect(mockGetIdentity).not.toHaveBeenCalled()
    expect(mockInitiateKyc).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      email: "user@example.com",
      type: "individual",
      full_name: "Test User",
    })
  })

  it("refuses a phone country Bridge cannot serve and never reaches Bridge", async () => {
    const result = await resolveWith({ phoneCountry: "IN", phone: "+919876543210" })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].code).toBe("BRIDGE_KYC_COUNTRY_NOT_SUPPORTED")
    expect(result.errors[0].message).toBe(
      "US virtual accounts aren't available in India yet.",
    )
    expect(mockInitiateKyc).not.toHaveBeenCalled()
  })

  it("falls back to parsing the phone number when lookup metadata is missing", async () => {
    const result = await resolveWith({ phoneCountry: undefined, phone: "+12125551234" })

    expect(result.errors).toEqual([])
    expect(mockInitiateKyc).toHaveBeenCalledTimes(1)
  })

  it("refuses an account with no phone at all", async () => {
    const result = await resolveWith({ phoneCountry: undefined, phone: undefined })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].code).toBe("BRIDGE_KYC_PHONE_REQUIRED")
    expect(mockInitiateKyc).not.toHaveBeenCalled()
  })

  it("does not start KYC immediately after signup any differently: no age rule", async () => {
    // A brand-new account with an allowed phone country goes straight through.
    const result = await resolveWith()
    expect(result.errors).toEqual([])
    expect(mockInitiateKyc).toHaveBeenCalledTimes(1)
  })

  it("enforces the verified-email rule when it is switched on", async () => {
    mockBridgeConfig.kycGate = { ...GATE_DEFAULTS(), requireVerifiedEmail: true }
    mockGetIdentity.mockResolvedValue({ emailVerified: false })

    const result = await resolveWith()

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].code).toBe("BRIDGE_KYC_EMAIL_NOT_VERIFIED")
    expect(result.errors[0].message).toBe(
      "Verify your email address before starting identity verification.",
    )
    expect(mockInitiateKyc).not.toHaveBeenCalled()
  })

  it("lets the country rule be switched off in config", async () => {
    mockBridgeConfig.kycGate = {
      requireVerifiedEmail: false,
      countryAllowlist: { enabled: false, defaultCountries: [] },
    }

    const result = await resolveWith({ phoneCountry: "IN", phone: "+919876543210" })

    expect(result.errors).toEqual([])
    expect(mockGetAllowedCountries).not.toHaveBeenCalled()
    expect(mockInitiateKyc).toHaveBeenCalledTimes(1)
  })

  it("answers a Kratos lookup failure as an error payload, not a throw", async () => {
    mockBridgeConfig.kycGate = { ...GATE_DEFAULTS(), requireVerifiedEmail: true }
    mockGetIdentity.mockResolvedValue(new UnknownKratosError("kratos unavailable"))

    const result = await resolveWith()

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBeTruthy()
    expect(mockInitiateKyc).not.toHaveBeenCalled()
  })

  it("still enforces the pre-existing level check before the gate", async () => {
    const result = await resolveWith({ level: 0 })

    expect(result.errors[0].code).toBe("BRIDGE_ACCOUNT_LEVEL_ERROR")
    expect(mockGetAllowedCountries).not.toHaveBeenCalled()
    expect(mockInitiateKyc).not.toHaveBeenCalled()
  })

  it("still enforces the pre-existing disabled check before the gate", async () => {
    mockBridgeConfig.enabled = false

    const result = await resolveWith()

    expect(result.errors[0].code).toBe("BRIDGE_DISABLED")
    expect(mockGetAllowedCountries).not.toHaveBeenCalled()
  })
})
