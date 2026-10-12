import {
  InvalidSplitPercentError,
  MAX_SPLIT_RULES_PER_WALLET,
  SelfSplitNotAllowedError,
  SplitCurrencyMismatchError,
  SplitDuplicateDestinationError,
  SplitPercentExceededError,
  SplitRuleLimitExceededError,
  validateSplitSet,
} from "@domain/payment-splits"
import { WalletCurrency } from "@domain/shared"

const SOURCE = "source-wallet"

const entry = (n: number, percent: number, currency: string = WalletCurrency.Usdt) => ({
  destinationWalletId: `dest-${n}`,
  destinationCurrency: currency,
  percent,
})

const validate = (entries: ReturnType<typeof entry>[], sourceCurrency = "USDT") =>
  validateSplitSet({ sourceWalletId: SOURCE, sourceCurrency, entries })

describe("validateSplitSet", () => {
  it("accepts a set that sums to exactly 100", () => {
    expect(validate([entry(1, 60), entry(2, 40)])).toBe(true)
  })

  it("accepts a set below 100 (the remainder stays with the owner)", () => {
    expect(validate([entry(1, 10)])).toBe(true)
  })

  it("rejects a set that sums to 101", () => {
    expect(validate([entry(1, 60), entry(2, 41)])).toBeInstanceOf(
      SplitPercentExceededError,
    )
  })

  it("accepts the empty set: it clears the wallet's splits", () => {
    expect(validate([])).toBe(true)
  })

  it("still rejects an empty set on a non-split currency", () => {
    expect(validate([], WalletCurrency.Btc)).toBeInstanceOf(SplitCurrencyMismatchError)
  })

  it("rejects non-integer and out-of-range percents", () => {
    expect(validate([entry(1, 12.5)])).toBeInstanceOf(InvalidSplitPercentError)
    expect(validate([entry(1, 0)])).toBeInstanceOf(InvalidSplitPercentError)
    expect(validate([entry(1, -5)])).toBeInstanceOf(InvalidSplitPercentError)
    expect(validate([entry(1, 101)])).toBeInstanceOf(InvalidSplitPercentError)
  })

  it("rejects a split to the source wallet itself", () => {
    expect(
      validateSplitSet({
        sourceWalletId: SOURCE,
        sourceCurrency: "USDT",
        entries: [
          { destinationWalletId: SOURCE, destinationCurrency: "USDT", percent: 5 },
        ],
      }),
    ).toBeInstanceOf(SelfSplitNotAllowedError)
  })

  it("rejects duplicate destinations", () => {
    expect(validate([entry(1, 10), entry(1, 20)])).toBeInstanceOf(
      SplitDuplicateDestinationError,
    )
  })

  it("rejects a destination in another currency", () => {
    expect(validate([entry(1, 10, WalletCurrency.Usd)])).toBeInstanceOf(
      SplitCurrencyMismatchError,
    )
  })

  it("rejects a BTC source wallet", () => {
    expect(
      validate([entry(1, 10, WalletCurrency.Btc)], WalletCurrency.Btc),
    ).toBeInstanceOf(SplitCurrencyMismatchError)
  })

  it("accepts the maximum number of rules and rejects one more", () => {
    const max = Array.from({ length: MAX_SPLIT_RULES_PER_WALLET }, (_, i) => entry(i, 1))
    expect(MAX_SPLIT_RULES_PER_WALLET).toBe(10)
    expect(validate(max)).toBe(true)
    expect(validate([...max, entry(99, 1)])).toBeInstanceOf(SplitRuleLimitExceededError)
  })
})
