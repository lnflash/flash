import { GiftCardProviderUnavailableError } from "@domain/gift-cards"

let mockConfig = makeGiftCardsConfig()

jest.mock("@config", () => ({
  get GiftCardsConfig() {
    return mockConfig
  },
}))

import {
  __resetGiftCardProvidersForTest,
  enabledGiftCardProviders,
  getEnabledGiftCardProvider,
  getGiftCardProviderForCountry,
  getRegisteredGiftCardProviderOrError,
  isGiftCardProviderEnabled,
  registerGiftCardProvider,
  resolveGiftCardProviderIdForCountry,
} from "@services/gift-cards/registry"

import { makeGiftCardsConfig } from "../../app/gift-cards/fixtures"

const fakeProvider = (id: GiftCardProviderId): IGiftCardProvider => ({
  id,
  listProducts: jest.fn(),
  quote: jest.fn(),
  createOrder: jest.fn(),
  getOrder: jest.fn(),
})

const tbc = fakeProvider("bitcoinCompany")

beforeEach(() => {
  __resetGiftCardProvidersForTest()
  registerGiftCardProvider(tbc)
  mockConfig = makeGiftCardsConfig()
})

describe("getRegisteredGiftCardProviderOrError (orders that already exist)", () => {
  it("returns the registered provider while it is enabled", () => {
    expect(getRegisteredGiftCardProviderOrError("bitcoinCompany")).toBe(tbc)
  })

  it("returns it while the master switch is off: settlement must outlive the kill switch", () => {
    mockConfig = makeGiftCardsConfig({ enabled: false })
    expect(getRegisteredGiftCardProviderOrError("bitcoinCompany")).toBe(tbc)
  })

  it("returns it while the provider switch is off", () => {
    mockConfig = makeGiftCardsConfig()
    mockConfig.providers.bitcoinCompany.enabled = false
    expect(getRegisteredGiftCardProviderOrError("bitcoinCompany")).toBe(tbc)
  })

  it("errors only when no adapter is registered under the id", () => {
    expect(getRegisteredGiftCardProviderOrError("bitrefill")).toBeInstanceOf(
      GiftCardProviderUnavailableError,
    )
    __resetGiftCardProvidersForTest()
    expect(getRegisteredGiftCardProviderOrError("bitcoinCompany")).toBeInstanceOf(
      GiftCardProviderUnavailableError,
    )
  })
})

describe("getEnabledGiftCardProvider (quote / purchase: new money)", () => {
  it("returns the provider when both switches are on", () => {
    expect(getEnabledGiftCardProvider("bitcoinCompany")).toBe(tbc)
  })

  it("refuses while the master switch is off", () => {
    mockConfig = makeGiftCardsConfig({ enabled: false })
    expect(getEnabledGiftCardProvider("bitcoinCompany")).toBeInstanceOf(
      GiftCardProviderUnavailableError,
    )
  })

  it("refuses while the provider switch is off", () => {
    mockConfig = makeGiftCardsConfig()
    mockConfig.providers.bitcoinCompany.enabled = false
    expect(getEnabledGiftCardProvider("bitcoinCompany")).toBeInstanceOf(
      GiftCardProviderUnavailableError,
    )
    expect(enabledGiftCardProviders()).toEqual([])
  })

  it("refuses an enabled id with no registered adapter", () => {
    mockConfig = makeGiftCardsConfig()
    mockConfig.providers.bitrefill.enabled = true
    expect(getEnabledGiftCardProvider("bitrefill")).toBeInstanceOf(
      GiftCardProviderUnavailableError,
    )
  })
})

describe("routing", () => {
  it("routes byCountry, else default, and requires the result to be enabled", () => {
    mockConfig = makeGiftCardsConfig({
      routing: { default: "bitcoinCompany", byCountry: { JM: "bitrefill" } },
    })
    expect(resolveGiftCardProviderIdForCountry("us")).toBe("bitcoinCompany")
    expect(getGiftCardProviderForCountry("US")).toBe(tbc)
    // Routed to a disabled provider: unavailable, never silently re-routed.
    expect(resolveGiftCardProviderIdForCountry("JM")).toBeInstanceOf(
      GiftCardProviderUnavailableError,
    )
  })

  it("matches byCountry keys case-insensitively: { jm: bitrefill } routes JM", () => {
    registerGiftCardProvider(fakeProvider("bitrefill"))
    mockConfig = makeGiftCardsConfig({
      routing: { default: "bitcoinCompany", byCountry: { jm: "bitrefill" } },
    })
    mockConfig.providers.bitrefill.enabled = true

    expect(resolveGiftCardProviderIdForCountry("JM")).toBe("bitrefill")
    expect(resolveGiftCardProviderIdForCountry("jm")).toBe("bitrefill")
    expect(resolveGiftCardProviderIdForCountry(" Jm ")).toBe("bitrefill")
    // Everything else still falls through to the default.
    expect(resolveGiftCardProviderIdForCountry("US")).toBe("bitcoinCompany")
  })
})

describe("registration gate", () => {
  // Config can name a provider no adapter registered under (a typo, or an
  // adapter whose import was dropped). That id must read as NOT enabled, or
  // the globals flag and the country gate would advertise gift cards while
  // every quote, purchase, and catalog read failed.
  it("an enabled id with no registered adapter is not enabled and does not route", () => {
    mockConfig = makeGiftCardsConfig({
      routing: { default: "bitcoinCompany", byCountry: { JM: "bitrefill" } },
    })
    mockConfig.providers.bitrefill.enabled = true

    expect(isGiftCardProviderEnabled("bitrefill")).toBe(false)
    expect(resolveGiftCardProviderIdForCountry("JM")).toBeInstanceOf(
      GiftCardProviderUnavailableError,
    )
    expect(getGiftCardProviderForCountry("JM")).toBeInstanceOf(
      GiftCardProviderUnavailableError,
    )
    expect(enabledGiftCardProviders()).toEqual([tbc])
  })

  it("the same id becomes enabled the moment an adapter registers under it", () => {
    mockConfig = makeGiftCardsConfig({
      routing: { default: "bitcoinCompany", byCountry: { JM: "bitrefill" } },
    })
    mockConfig.providers.bitrefill.enabled = true
    const bitrefill = fakeProvider("bitrefill")

    registerGiftCardProvider(bitrefill)

    expect(isGiftCardProviderEnabled("bitrefill")).toBe(true)
    expect(resolveGiftCardProviderIdForCountry("JM")).toBe("bitrefill")
    expect(getGiftCardProviderForCountry("JM")).toBe(bitrefill)
    expect(enabledGiftCardProviders()).toEqual([tbc, bitrefill])
  })

  it("a registered adapter whose config is off stays not enabled", () => {
    expect(isGiftCardProviderEnabled("bitcoinCompany")).toBe(true)
    mockConfig.providers.bitcoinCompany.enabled = false
    expect(isGiftCardProviderEnabled("bitcoinCompany")).toBe(false)
  })
})
