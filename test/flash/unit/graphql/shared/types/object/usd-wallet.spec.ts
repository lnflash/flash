import { usdtMicrosToUsdCents } from "@graphql/shared/types/object/usd-wallet"

describe("UsdWallet legacy compatibility balance", () => {
  it("converts USDT micros to USD cents from integer smallest units", () => {
    expect(usdtMicrosToUsdCents("10000000")).toBe(1000)
  })

  it("accepts formatted USDT smallest units from precision calls", () => {
    expect(usdtMicrosToUsdCents("10000000.00000000")).toBe(1000)
  })

  it("rejects non-zero fractional micros", () => {
    expect(() => usdtMicrosToUsdCents("10000000.5")).toThrow(
      "Cannot convert fractional USDT micros",
    )
  })
})
