// jest.mock calls are hoisted before imports

import GlobalsQuery from "@graphql/public/root/query/globals"

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

describe("globals query — giftCardsEnabled", () => {
  it("is true when the rail is on and at least one provider is enabled", async () => {
    mockGiftCardsConfig = makeGiftCardsConfig() // enabled, bitcoinCompany on

    expect((await resolveGlobals()).giftCardsEnabled).toBe(true)
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

  it("counts ANY enabled provider, not only the default route", async () => {
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
