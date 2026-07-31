export interface ReferralRewardTier {
  // Inclusive upper bound (cumulative) of the referral sequence for this tier.
  // A value <= 0 marks the final, unbounded tier.
  upToCount: number
  amountCents: number
}

// Given the ordered tiers and a 1-based referral sequence number, return the
// per-party reward amount (in USD cents) for that referral.
//
// Tiers are cumulative. For the default schedule
//   [{ upToCount: 100, amountCents: 500 },
//    { upToCount: 600, amountCents: 250 },
//    { upToCount: 0,   amountCents: 100 }]
// seq 1..100 -> 500, 101..600 -> 250, 601+ -> 100.
export const referralRewardAmountCents = (
  tiers: ReferralRewardTier[],
  seq: number,
): number => {
  for (const tier of tiers) {
    if (tier.upToCount > 0 && seq <= tier.upToCount) return tier.amountCents
  }
  const last = tiers[tiers.length - 1]
  return last ? last.amountCents : 0
}
