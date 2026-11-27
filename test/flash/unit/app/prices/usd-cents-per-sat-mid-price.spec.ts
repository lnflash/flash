// usdCentsPerSatMidPrice prices every sat-denominated on-chain send from a
// dollar wallet (usdCentsToDeliverSats). Its unit is US cents per sat: a
// change that returned dollars per sat, or a display ratio, would underpay
// those sends by 100x while every caller's spec (which mocks this function)
// still passed.

jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  getDealerConfig: () => ({ usd: { hedgingEnabled: false } }),
}))

jest.mock("@services/dealer-price", () => ({
  DealerPriceService: () => ({
    getCentsPerSatsExchangeMidRate: () => {
      throw new Error("the dealer is not asked while hedging is off")
    },
  }),
}))

const mockWalletPriceRatio = jest.fn()
jest.mock("@app/prices/get-current-price", () => ({
  ...jest.requireActual("@app/prices/get-current-price"),
  getCurrentPriceAsWalletPriceRatio: (args: unknown) => mockWalletPriceRatio(args),
}))

const mockSatRealTimePrice = jest.fn()
jest.mock("@services/price", () => ({
  PriceService: () => ({
    getSatRealTimePrice: (args: unknown) => mockSatRealTimePrice(args),
  }),
}))

jest.mock("@services/cache/local-cache", () => ({
  LocalCacheService: () => ({
    get: async () => ({}),
    set: async () => true,
  }),
}))

import { usdCentsPerSatMidPrice } from "@app/prices/mid-price"

import { WalletPriceRatio } from "@domain/payments"
import { PriceNotAvailableError } from "@domain/price"
import { UsdDisplayCurrency } from "@domain/fiat"

const { getCurrentPriceAsWalletPriceRatio: realWalletPriceRatio } = jest.requireActual(
  "@app/prices/get-current-price",
)

describe("usdCentsPerSatMidPrice", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns US cents per sat from the wallet price ratio", async () => {
    // 6,000,000 cents for 100,000,000 sats is $60,000 a bitcoin.
    mockWalletPriceRatio.mockResolvedValue(
      WalletPriceRatio({
        usd: { amount: 6_000_000n, currency: "USD" },
        btc: { amount: 100_000_000n, currency: "BTC" },
      }),
    )

    expect(await usdCentsPerSatMidPrice()).toBe(0.06)
    expect(mockWalletPriceRatio).toHaveBeenCalledWith({ currency: UsdDisplayCurrency })
  })

  it("returns the price error unchanged", async () => {
    const error = new PriceNotAvailableError()
    mockWalletPriceRatio.mockResolvedValue(error)

    expect(await usdCentsPerSatMidPrice()).toBe(error)
  })

  it("scales the price service's dollars per sat to cents per sat", async () => {
    // Runs the real getCurrentPriceAsWalletPriceRatio, so the 10^2 scaling of
    // the price service's major-unit price is under test. $60,000 a bitcoin
    // is 0.0006 dollars a sat, which must come back as 0.06 cents a sat.
    mockWalletPriceRatio.mockImplementation(realWalletPriceRatio)
    mockSatRealTimePrice.mockResolvedValue({
      timestamp: new Date(),
      currency: UsdDisplayCurrency,
      price: 60_000 / 100_000_000,
    })

    expect(await usdCentsPerSatMidPrice()).toBeCloseTo(0.06, 10)
    expect(mockSatRealTimePrice).toHaveBeenCalledWith({
      displayCurrency: UsdDisplayCurrency,
    })
  })
})
