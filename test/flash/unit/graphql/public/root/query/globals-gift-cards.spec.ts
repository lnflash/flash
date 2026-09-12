// jest.mock calls are hoisted before imports

import GlobalsQuery from "@graphql/public/root/query/globals"
import {
  __resetGiftCardProvidersForTest,
  registerGiftCardProvider,
} from "@services/gift-cards/registry"

import { makeGiftCardsConfig } from "test/flash/unit/app/gift-cards/fixtures"

let mockGiftCardsConfig = makeGiftCardsConfig()

jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  get GiftCardsConfig() {
    return mockGiftCardsConfig
  },
}))

jest.mock("@services/fygaro/webhook-server/fygaro-settings", () => ({
  getFygaroSettings: jest.fn().mockResolvedValue(undefined),
}))

type GlobalsResult = { giftCardsEnabled: boolean }

const resolveGlobals = async (): Promise<GlobalsResult> => {
  const query = GlobalsQuery as unknown as {
    resolve: (
      source: null,
      args: Record<string, never>,
      context: unknown,
      info: never,
    ) => Promise<GlobalsResult>
  }
  return query.resolve(null, {}, {}, undefined as never)
}

const providersOff = () => {
  const base = makeGiftCardsConfig()
  return {
    bitcoinCompany: { ...base.providers.bitcoinCompany, enabled: false },
    bitrefill: { ...base.providers.bitrefill, enabled: false },
  }
}

// The flag is "registered AND enabled": config alone must not advertise a
// provider no adapter backs (every gift-card field would then fail). The
// registry is a module-level map, so a stub adapter is registered per test.
const stubProvider = (id: GiftCardProviderId): IGiftCardProvider =>
  ({ id }) as unknown as IGiftCardProvider

beforeEach(() => {
  __resetGiftCardProvidersForTest()
  registerGiftCardProvider(stubProvider("bitcoinCompany"))
})

afterAll(() => {
  __resetGiftCardProvidersForTest()
})

describe("globals query — giftCardsEnabled", () => {
  it("is true when the rail is on and at least one registered provider is enabled", async () => {
    mockGiftCardsConfig = makeGiftCardsConfig() // enabled, bitcoinCompany on

    expect((await resolveGlobals()).giftCardsEnabled).toBe(true)
  })

  it("is false when the enabled provider has no registered adapter", async () => {
    // `bitrefill` has no adapter on disk; enabling it in config alone must not
    // light the entry point up, or the catalog would answer PROVIDER_UNAVAILABLE.
    __resetGiftCardProvidersForTest()
    mockGiftCardsConfig = makeGiftCardsConfig() // enabled, bitcoinCompany on, unregistered

    expect((await resolveGlobals()).giftCardsEnabled).toBe(false)
  })

  it("is false when the rail flag is off, even with a provider enabled", async () => {
    mockGiftCardsConfig = makeGiftCardsConfig({ enabled: false })

    expect((await resolveGlobals()).giftCardsEnabled).toBe(false)
  })

  it("is false when the rail is on but every provider is disabled", async () => {
    // Every giftCard* field would answer GIFT_CARD_PROVIDER_UNAVAILABLE, so the
    // entry point must stay hidden: the flag alone is not the truth.
    mockGiftCardsConfig = makeGiftCardsConfig({ providers: providersOff() })

    expect((await resolveGlobals()).giftCardsEnabled).toBe(false)
  })

  it("counts ANY registered and enabled provider, not only the default route", async () => {
    registerGiftCardProvider(stubProvider("bitrefill"))
    const base = makeGiftCardsConfig()
    mockGiftCardsConfig = makeGiftCardsConfig({
      providers: {
        bitcoinCompany: { ...base.providers.bitcoinCompany, enabled: false },
        bitrefill: { ...base.providers.bitrefill, enabled: true },
      },
    })

    expect((await resolveGlobals()).giftCardsEnabled).toBe(true)
  })
})
