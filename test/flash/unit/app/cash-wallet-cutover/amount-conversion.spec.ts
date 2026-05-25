import {
  destinationShortfallUsdtMicros,
  feeUsdCentsToUsdtMicros,
  usdCentsToUsdtMicros,
  usdtMicrosToUsdCentsCeil,
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

  it("rounds USDT micros up to USD cents for fee audit fields", () => {
    expect(usdtMicrosToUsdCentsCeil("0")).toBe("0")
    expect(usdtMicrosToUsdCentsCeil("1")).toBe("1")
    expect(usdtMicrosToUsdCentsCeil("10000")).toBe("1")
    expect(usdtMicrosToUsdCentsCeil("10001")).toBe("2")
  })

  it("computes destination USDT shortfall from the observed balance delta", () => {
    expect(
      destinationShortfallUsdtMicros({
        targetUsdtMicros: "10000000",
        startingUsdtMicros: "5000000",
        currentUsdtMicros: "14930000",
      }),
    ).toBe("70000")
    expect(
      destinationShortfallUsdtMicros({
        targetUsdtMicros: "10000000",
        startingUsdtMicros: "5000000",
        currentUsdtMicros: "15000000",
      }),
    ).toBe("0")
  })

  it("rejects invalid or fractional cent inputs", () => {
    expect(usdCentsToUsdtMicros("1.5")).toBeInstanceOf(Error)
    expect(usdCentsToUsdtMicros("abc")).toBeInstanceOf(Error)
    expect(usdCentsToUsdtMicros("-1")).toBeInstanceOf(Error)
    expect(usdtMicrosToUsdCentsCeil("1.5")).toBeInstanceOf(Error)
  })
})
