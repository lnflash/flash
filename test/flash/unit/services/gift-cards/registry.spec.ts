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
})
