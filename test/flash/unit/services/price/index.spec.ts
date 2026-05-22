import { PriceService } from "@services/price"
import { WalletCurrency } from "@domain/shared"

describe("PriceService", () => {
  it("uses the configured JMD sell rate for USD-cent realtime prices", async () => {
    const price = await PriceService().getUsdCentRealTimePrice({
      displayCurrency: WalletCurrency.Jmd as DisplayCurrency,
    })

    expect(price).not.toBeInstanceOf(Error)
    if (price instanceof Error) throw price

    expect(price.currency).toBe(WalletCurrency.Jmd)
    expect(price.price).toBe(1.6)
  })
})
