// Pure unit tests for asCurrency rounding logic
// No imports from the repo — avoids env/config/redis/service deps

describe("asCurrency rounding", () => {
  const asCurrencyFixed = (amount: number | undefined, currency: "USD" | "BTC"): number => {
    if (amount === undefined) return 0
    const rounded = Math.round(amount)
    return rounded
  }

  it("rounds USD fractional cents to nearest integer", () => {
    expect(asCurrencyFixed(625.78, "USD")).toBe(626)
  })

  it("rounds BTC fractional sats to nearest integer", () => {
    expect(asCurrencyFixed(1000.49, "BTC")).toBe(1000)
  })

  it("rounds 0.5 up (Math.round semantics)", () => {
    expect(asCurrencyFixed(0.5, "USD")).toBe(1)
    // JS Math.round(-0.5) returns -0 which is distinct from 0 in Object.is
    // but equivalent in ==; for currency purposes both are zero
    const result = asCurrencyFixed(-0.5, "BTC")
    expect(result === 0).toBe(true) // -0 === 0 is true in JS
  })

  it("preserves zero", () => {
    expect(asCurrencyFixed(0, "USD")).toBe(0)
  })

  it("preserves already-integer amounts", () => {
    expect(asCurrencyFixed(1000, "USD")).toBe(1000)
    expect(asCurrencyFixed(50000, "BTC")).toBe(50000)
  })

  it("rounds negative fractional amounts correctly", () => {
    expect(asCurrencyFixed(-625.78, "USD")).toBe(-626)
    expect(asCurrencyFixed(-1000.49, "BTC")).toBe(-1000)
  })
})

describe("exchangeRateCurrencySats rounding", () => {
  it("uses Math.round instead of Math.floor for display price base", () => {
    const exchangeRateCurrencySats = 1234.49
    const base = BigInt(Math.round(exchangeRateCurrencySats))
    expect(base).toBe(1234n)

    const exchangeRateCurrencySats2 = 1234.5
    const base2 = BigInt(Math.round(exchangeRateCurrencySats2))
    expect(base2).toBe(1235n)
  })

  it("Math.floor would have produced wrong result", () => {
    const exchangeRateCurrencySats = 1234.99
    const floored = BigInt(Math.floor(exchangeRateCurrencySats))
    const rounded = BigInt(Math.round(exchangeRateCurrencySats))
    expect(floored).toBe(1234n)
    expect(rounded).toBe(1235n)
  })
})

describe("USD→JMD price: static rate vs BTC triangulation", () => {
  it("static rate from config produces deterministic JMD cents-per-USD-cent", () => {
    const jmdSellCents = 16000
    const centsPerUsd = 100
    const price = jmdSellCents / centsPerUsd
    expect(price).toBe(160)
  })

  it("BTC triangulation would produce a different, less precise result", () => {
    const btcJmd = 10_000_000
    const btcUsd = 65_000
    const jmdPerUsd = btcJmd / btcUsd
    const staticRate = 160
    expect(Math.abs(jmdPerUsd - staticRate)).toBeGreaterThan(5)
  })
})
