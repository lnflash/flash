import {
  usdCentsToUsdtMicros,
  usdtMicrosToUsdCents,
} from "@app/cash-wallet-cutover/amount-conversion"
import { InvalidCashWalletCutoverAmountError } from "@app/cash-wallet-cutover/errors"

describe("cash wallet cutover amount conversion", () => {
  it("converts precise USD cents to USDT micros", () => {
    expect(usdCentsToUsdtMicros("24.035292")).toBe("240353")
    expect(usdCentsToUsdtMicros("24.744298")).toBe("247443")
  })
})

// Wallet `balance` is typed FractionalCentAmount, but the USDT branch rounded
// to whole cents (half-to-even) before serving — reporting up to half a cent
// more than the wallet holds. A client that sent the reported balance then
// failed at IBEX with "insufficient balance. Current Balance: 1.099346 ...
// invoice amount: 1.100000" (on-device repro, 2026-08-13). These pin the
// fractional contract.
describe("usdtMicrosToUsdCents", () => {
  it("preserves fractional cents instead of rounding up (device repro)", () => {
    // 1.099346 USDT = 1,099,346 micros. Rounded reporting said 110.
    expect(usdtMicrosToUsdCents("1099346")).toBe(109.9346)
  })

  it("does not round half-to-even at the cent boundary", () => {
    // 109.5 cents exactly — whole-cent rounding reported 110 (HALF_TO_EVEN).
    expect(usdtMicrosToUsdCents("1095000")).toBe(109.5)
  })

  it("returns whole cents untouched", () => {
    expect(usdtMicrosToUsdCents("1100000")).toBe(110)
    expect(usdtMicrosToUsdCents("0")).toBe(0)
  })

  it("keeps full micro precision (4 decimal places)", () => {
    expect(usdtMicrosToUsdCents("1")).toBe(0.0001)
    expect(usdtMicrosToUsdCents("9999")).toBe(0.9999)
  })

  it("accepts bigint and number inputs", () => {
    expect(usdtMicrosToUsdCents(1099346n)).toBe(109.9346)
    expect(usdtMicrosToUsdCents(1099346)).toBe(109.9346)
  })

  it("tolerates a zero-valued fractional part (Money toFixed output)", () => {
    expect(usdtMicrosToUsdCents("1099346.00")).toBe(109.9346)
  })

  it("preserves the sign of negative balances (FractionalCentAmount is signed)", () => {
    // IBEX can report a small negative balance (fee reconciliation / ledger
    // anomaly); erroring here would break the wallet's balance field on
    // every query.
    expect(usdtMicrosToUsdCents("-123")).toBe(-0.0123)
    expect(usdtMicrosToUsdCents("-1099346")).toBe(-109.9346)
    expect(usdtMicrosToUsdCents(-1099346n)).toBe(-109.9346)
    expect(usdtMicrosToUsdCents(-1099346)).toBe(-109.9346)
  })

  it("normalizes negative zero to zero", () => {
    expect(usdtMicrosToUsdCents("-0")).toBe(0)
  })

  it("returns the module error for fractional micros", () => {
    const result = usdtMicrosToUsdCents("1099346.5")
    expect(result).toBeInstanceOf(InvalidCashWalletCutoverAmountError)
    expect((result as Error).message).toMatch(/Cannot convert fractional USDT micros/)
  })

  it("returns the module error for malformed input", () => {
    expect(usdtMicrosToUsdCents("abc")).toBeInstanceOf(
      InvalidCashWalletCutoverAmountError,
    )
    expect(usdtMicrosToUsdCents("-")).toBeInstanceOf(InvalidCashWalletCutoverAmountError)
    expect(usdtMicrosToUsdCents("1-2")).toBeInstanceOf(
      InvalidCashWalletCutoverAmountError,
    )
  })
})
