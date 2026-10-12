import { computeShare, splitRetryBackoffMs } from "@domain/payment-splits"
import { WalletCurrency } from "@domain/shared"

const share = (amount: number, currency: string, percent: number, minShareCents = 1) =>
  computeShare({ amount, currency, percent, minShareCents })

describe("computeShare", () => {
  it("floors a USD share to whole cents: 10% of $0.99 is 9 cents", () => {
    expect(share(0.99, WalletCurrency.Usd, 10)).toEqual({
      status: "ok",
      triggerAmountMinor: "99",
      shareCents: 9,
    })
  })

  it("floors a USDT share in micros, then to cents: 10% of 1.234567 USDT is 12 cents", () => {
    expect(share(1.234567, WalletCurrency.Usdt, 10)).toEqual({
      status: "ok",
      triggerAmountMinor: "1234567",
      shareCents: 12,
    })
  })

  it("pays 100% of a whole-cent USD receive exactly", () => {
    expect(share(19.46, WalletCurrency.Usd, 100)).toMatchObject({ shareCents: 1946 })
  })

  it("never rounds a share up across a set", () => {
    // 3 x 33% of $1.00 = 99 cents, never more than the receive.
    const shares = [33, 33, 33].map((p) => share(1, WalletCurrency.Usd, p))
    const total = shares.reduce(
      (sum, s) => sum + (s instanceof Error ? 0 : s.shareCents),
      0,
    )
    expect(total).toBeLessThanOrEqual(100)
  })

  it("marks a sub-1-cent share skipped_min", () => {
    expect(share(0.05, WalletCurrency.Usd, 10)).toEqual({
      status: "skipped_min",
      triggerAmountMinor: "5",
      shareCents: 0,
    })
    expect(share(0.000099, WalletCurrency.Usdt, 100)).toMatchObject({
      status: "skipped_min",
      shareCents: 0,
    })
  })

  it("honours a higher minShareCents", () => {
    expect(share(1, WalletCurrency.Usd, 10, 25)).toMatchObject({
      status: "skipped_min",
      shareCents: 10,
    })
  })

  it("rejects BTC, negative amounts and invalid percents", () => {
    expect(share(1, WalletCurrency.Btc, 10)).toBeInstanceOf(Error)
    expect(share(-1, WalletCurrency.Usd, 10)).toBeInstanceOf(Error)
    expect(share(1, WalletCurrency.Usd, 0)).toBeInstanceOf(Error)
    expect(share(1, WalletCurrency.Usd, 10.5)).toBeInstanceOf(Error)
  })
})

describe("splitRetryBackoffMs", () => {
  it("backs off 1, 2, 4, 8, 16 minutes", () => {
    expect([1, 2, 3, 4, 5].map(splitRetryBackoffMs)).toEqual(
      [1, 2, 4, 8, 16].map((m) => m * 60_000),
    )
  })
})
