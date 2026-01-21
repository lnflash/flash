import mongoose, { Schema } from "mongoose"

export enum InviteMethod {
  EMAIL = "EMAIL",
  SMS = "SMS",
  WHATSAPP = "WHATSAPP",
}

export enum InviteStatus {
  PENDING = "PENDING",
  SENT = "SENT",
  ACCEPTED = "ACCEPTED",
  EXPIRED = "EXPIRED",
}

export interface InviteRecord {
  contact: string
  method: InviteMethod
  tokenHash: string
  inviterId: mongoose.Types.ObjectId
  status: InviteStatus
  createdAt: Date
  expiresAt: Date
  redeemedAt?: Date
  redeemedById?: mongoose.Types.ObjectId
  revokedAt?: Date
  revokeReason?: string
}

const InviteSchema = new Schema<InviteRecord>({
  contact: {
    type: String,
    required: true,
    index: true,
  },
  method: {
    type: String,
    enum: Object.values(InviteMethod),
    required: true,
  },
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  inviterId: {
    type: Schema.Types.ObjectId,
    ref: "Account",
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: Object.values(InviteStatus),
    default: InviteStatus.PENDING,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  redeemedAt: {
    type: Date,
  },
  redeemedById: {
    type: Schema.Types.ObjectId,
    ref: "Account",
    index: true,
  },
  revokedAt: {
    type: Date,
  },
  revokeReason: {
    type: String,
  },
})

InviteSchema.index({ inviterId: 1, createdAt: -1 })
InviteSchema.index({ contact: 1, createdAt: -1 })
InviteSchema.index({ status: 1, expiresAt: 1 })

export const InviteRepository = mongoose.model<InviteRecord>("Invite", InviteSchema)
