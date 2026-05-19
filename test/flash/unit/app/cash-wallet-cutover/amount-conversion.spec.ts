import {
  feeUsdCentsToUsdtMicros,
  usdCentsToUsdtMicros,
} from "@app/cash-wallet-cutover/amount-conversion"

describe("cash wallet cutover amount conversion", () => {
  it("converts USD cents to USDT micros exactly", () => {
    expect(usdCentsToUsdtMicros("0")).toBe("0")
    expect(usdCentsToUsdtMicros("1")).toBe("10000")
    expect(usdCentsToUsdtMicros("100")).toBe("1000000")
    expect(usdCentsToUsdtMicros("123456789")).toBe("1234567890000")
  })

  it("converts fee USD cents to USDT micros exactly", () => {
    expect(feeUsdCentsToUsdtMicros("7")).toBe("70000")
  })

  it("rejects invalid or fractional cent inputs", () => {
    expect(usdCentsToUsdtMicros("1.5")).toBeInstanceOf(Error)
    expect(usdCentsToUsdtMicros("abc")).toBeInstanceOf(Error)
    expect(usdCentsToUsdtMicros("-1")).toBeInstanceOf(Error)
  })
})
