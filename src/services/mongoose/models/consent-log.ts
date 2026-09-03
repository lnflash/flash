import mongoose, { Schema } from "mongoose"

// Compliance record of a consent submission from the getflash.io/invite
// landing page (ENG-568). Written by the public /consent/log endpoint.
//
// These are evidence records: append-only, never updated, no TTL — the whole
// point is to be able to show later who consented to what, when, from where.
// The invite token is stored ONLY as a hash (same rule as the invites
// collection); the raw token never touches disk here.
export interface ConsentLogRecord {
  version: string
  consents: {
    transactional: { optedIn: boolean; purpose?: string; frequency?: string }
    marketing: { optedIn: boolean; purpose?: string; frequency?: string }
  }
  inviteTokenHash?: string
  sourceUrl?: string
  userAgent?: string
  clientTimestamp?: string
  ip?: string
  receivedAt: Date
}

const ConsentLegSchema = new Schema(
  {
    optedIn: { type: Boolean, required: true },
    purpose: { type: String, maxlength: 256 },
    frequency: { type: String, maxlength: 64 },
  },
  { _id: false },
)

const ConsentLogSchema = new Schema<ConsentLogRecord>({
  version: { type: String, required: true, maxlength: 64 },
  consents: {
    transactional: { type: ConsentLegSchema, required: true },
    marketing: { type: ConsentLegSchema, required: true },
  },
  inviteTokenHash: { type: String, maxlength: 128, index: true },
  sourceUrl: { type: String, maxlength: 2048 },
  userAgent: { type: String, maxlength: 1024 },
  // The client's own clock, kept verbatim as evidence of what the client
  // asserted; receivedAt below is the trustworthy ordering field.
  clientTimestamp: { type: String, maxlength: 64 },
  ip: { type: String, maxlength: 64 },
  receivedAt: { type: Date, required: true, default: Date.now, index: true },
})

export const ConsentLogRepository = mongoose.model<ConsentLogRecord>(
  "ConsentLog",
  ConsentLogSchema,
)
