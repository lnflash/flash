import { usdCentsToUsdtMicros } from "@app/cash-wallet-cutover/amount-conversion"

describe("cash wallet cutover amount conversion", () => {
  it("converts precise USD cents to USDT micros", () => {
    expect(usdCentsToUsdtMicros("24.035292")).toBe("240353")
    expect(usdCentsToUsdtMicros("24.744298")).toBe("247443")
  })
})
