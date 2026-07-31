import { referralRewardAmountCents } from "@domain/invite/referral-reward"

const DEFAULT_TIERS = [
  { upToCount: 100, amountCents: 500 },
  { upToCount: 600, amountCents: 250 },
  { upToCount: 0, amountCents: 100 },
]

describe("referralRewardAmountCents", () => {
  describe("default tiered schedule", () => {
    it.each([
      [1, 500],
      [100, 500],
      [101, 250],
      [600, 250],
      [601, 100],
      [5000, 100],
    ])("seq %i -> %i cents", (seq, expected) => {
      expect(referralRewardAmountCents(DEFAULT_TIERS, seq)).toBe(expected)
    })
  })

  it("returns 0 when there are no tiers", () => {
    expect(referralRewardAmountCents([], 1)).toBe(0)
    expect(referralRewardAmountCents([], 999)).toBe(0)
  })

  it("treats a single unbounded tier as covering every sequence", () => {
    const tiers = [{ upToCount: 0, amountCents: 100 }]
    expect(referralRewardAmountCents(tiers, 1)).toBe(100)
    expect(referralRewardAmountCents(tiers, 1_000_000)).toBe(100)
  })

  it("falls back to the last tier's amount past the final bound", () => {
    const tiers = [
      { upToCount: 10, amountCents: 500 },
      { upToCount: 20, amountCents: 250 },
    ]
    // 25 is past every positive bound; last tier amount is used.
    expect(referralRewardAmountCents(tiers, 25)).toBe(250)
  })
})
