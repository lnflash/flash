import mongoose, { Schema } from "mongoose"

// A single-document, monotonically-increasing counter used to assign each paid
// referral a unique sequence number. The sequence drives the tiered reward
// amount (e.g. first 100 referrals pay more). An atomic `$inc` guarantees no two
// concurrent payouts get the same number, so tier boundaries are exact.
export interface ReferralRewardCounterRecord {
  _id: string
  seq: number
}

const ReferralRewardCounterSchema = new Schema<ReferralRewardCounterRecord>({
  _id: { type: String },
  seq: { type: Number, default: 0 },
})

export const ReferralRewardCounter = mongoose.model<ReferralRewardCounterRecord>(
  "ReferralRewardCounter",
  ReferralRewardCounterSchema,
)

const COUNTER_ID = "referral_reward"

// Atomically reserve and return the next referral sequence number (1-based).
export const nextReferralRewardSeq = async (): Promise<number> => {
  const doc = await ReferralRewardCounter.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  )
  return doc.seq
}
