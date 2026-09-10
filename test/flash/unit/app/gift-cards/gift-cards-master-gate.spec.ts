import { CouldNotFindUserFromIdError } from "@domain/errors"
import {
  GiftCardProviderUnavailableError,
  GiftCardsDisabledError,
} from "@domain/gift-cards"

import {
  giftCardsMasterGate,
  resolveAccountCountryCode,
  resolveAccountCountryCodeOrUnknown,
  UNKNOWN_COUNTRY_CODE,
} from "@app/gift-cards/gift-cards-master-gate"

import { makeAccount, makeGiftCardsConfig } from "./fixtures"

const mockFindUserById = jest.fn()
const mockResolvePhoneCountries = jest.fn()

let mockConfig = makeGiftCardsConfig()

jest.mock("@config", () => ({
  get GiftCardsConfig() {
    return mockConfig
  },
}))
jest.mock("@services/mongoose", () => ({
  UsersRepository: () => ({ findById: (...a: unknown[]) => mockFindUserById(...a) }),
}))
jest.mock("@app/bridge/kyc-gate", () => ({
  resolvePhoneCountries: (...a: unknown[]) => mockResolvePhoneCountries(...a),
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

const withConfig = (overrides: Record<string, unknown>) => {
  mockConfig = makeGiftCardsConfig(overrides)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockConfig = makeGiftCardsConfig()
  mockFindUserById.mockResolvedValue({ id: "kratos-1", phone: "+18765550100" })
  mockResolvePhoneCountries.mockReturnValue({ countries: ["JM"], source: "lookup" })
})

describe("giftCardsMasterGate", () => {
  it("opens with the routed provider", () => {
    expect(giftCardsMasterGate("US")).toEqual({ ok: true, providerId: "bitcoinCompany" })
  })

  it("closes with GiftCardsDisabledError when the rail is off", () => {
    withConfig({ enabled: false })
    expect(giftCardsMasterGate("US")).toEqual({
      ok: false,
      error: expect.any(GiftCardsDisabledError),
    })
  })

  it("closes with GiftCardProviderUnavailableError when the routed provider is disabled", () => {
    const base = makeGiftCardsConfig()
    withConfig({
      providers: {
        ...base.providers,
        bitcoinCompany: { ...base.providers.bitcoinCompany, enabled: false },
      },
    })
    expect(giftCardsMasterGate("US")).toEqual({
      ok: false,
      error: expect.any(GiftCardProviderUnavailableError),
    })
  })

  it("routes by country, case-insensitively", () => {
    const base = makeGiftCardsConfig()
    withConfig({
      routing: { default: "bitcoinCompany", byCountry: { JM: "bitrefill" } },
      providers: {
        ...base.providers,
        bitrefill: { ...base.providers.bitrefill, enabled: true },
      },
    })
    expect(giftCardsMasterGate("jm")).toEqual({ ok: true, providerId: "bitrefill" })
    expect(giftCardsMasterGate("US")).toEqual({ ok: true, providerId: "bitcoinCompany" })
  })

  it("a country routed to a disabled provider is unavailable even though the default is on", () => {
    withConfig({ routing: { default: "bitcoinCompany", byCountry: { JM: "bitrefill" } } })
    expect(giftCardsMasterGate("JM")).toEqual({
      ok: false,
      error: expect.any(GiftCardProviderUnavailableError),
    })
  })

  it("the unknown-country sentinel and an empty string both take the default route", () => {
    expect(giftCardsMasterGate(UNKNOWN_COUNTRY_CODE)).toEqual({
      ok: true,
      providerId: "bitcoinCompany",
    })
    expect(giftCardsMasterGate("")).toEqual({ ok: true, providerId: "bitcoinCompany" })
  })
})

describe("resolveAccountCountryCode", () => {
  it("returns the single phone country", async () => {
    await expect(resolveAccountCountryCode(makeAccount())).resolves.toBe("JM")
    expect(mockFindUserById).toHaveBeenCalledWith("kratos-1")
  })

  it("returns null for an ambiguous calling-code set", async () => {
    mockResolvePhoneCountries.mockReturnValue({
      countries: ["US", "CA", "JM"],
      source: "calling-code",
      callingCode: "1",
    })
    await expect(resolveAccountCountryCode(makeAccount())).resolves.toBeNull()
  })

  it("returns null when nothing resolves", async () => {
    mockResolvePhoneCountries.mockReturnValue({ countries: [], source: "none" })
    await expect(resolveAccountCountryCode(makeAccount())).resolves.toBeNull()
  })

  it("returns null when the user cannot be loaded", async () => {
    mockFindUserById.mockResolvedValue(new CouldNotFindUserFromIdError())
    await expect(resolveAccountCountryCode(makeAccount())).resolves.toBeNull()
  })

  it("never throws", async () => {
    mockFindUserById.mockRejectedValue(new Error("mongo down"))
    await expect(resolveAccountCountryCode(makeAccount())).resolves.toBeNull()
  })

  it("OrUnknown maps null to the routing sentinel", async () => {
    mockResolvePhoneCountries.mockReturnValue({ countries: [], source: "none" })
    await expect(resolveAccountCountryCodeOrUnknown(makeAccount())).resolves.toBe(
      UNKNOWN_COUNTRY_CODE,
    )
  })
})
