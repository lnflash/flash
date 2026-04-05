import { ExchangeRates } from "@config"
import { CENTS_PER_USD } from "@domain/fiat"

jest.mock("@services/price/grpc", () => ({
  PriceProtoDescriptor: {
    PriceFeed: jest.fn().mockImplementation(() => ({
      getPrice: jest.fn(),
      listCurrencies: jest.fn(),
    })),
  },
  PriceHistoryProtoDescriptor: {
    PriceHistory: jest.fn().mockImplementation(() => ({
      listPrices: jest.fn(),
    })),
  },
}))

import { PriceService } from "@services/price"
import { PriceProtoDescriptor } from "@services/price/grpc"

const getPriceMock = () =>
  ((PriceProtoDescriptor.PriceFeed as jest.Mock).mock.results[0]?.value.getPrice ??
    jest.fn()) as jest.Mock

describe("PriceService", () => {
  beforeEach(() => {
    getPriceMock().mockReset()
  })

  it("uses the configured JMD sell rate for USD cent realtime prices", async () => {
    const result = await PriceService().getUsdCentRealTimePrice({
      displayCurrency: "JMD" as DisplayCurrency,
    })

    if (result instanceof Error) throw result

    expect(result.currency).toBe("JMD")
    expect(result.price).toBe(Number(ExchangeRates.jmd.sell.asCents(2)) / CENTS_PER_USD)
    expect(getPriceMock()).not.toHaveBeenCalled()
  })
})
