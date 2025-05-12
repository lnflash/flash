import { ApiKeyStatus, ApiKeyType } from "@domain/api-keys"
import mongoose from "mongoose"
import crypto from "crypto"

const Schema = mongoose.Schema

interface ApiKeyUsageRecord {
  endpoint: string
  ip: string
  timestamp: Date
  success: boolean
  responseTimeMs: number
  statusCode: number
}

export interface ApiKeyRotationRecord {
  originalKeyId: string
  newKeyId: string
  status: "pending" | "in_progress" | "completed" | "failed"
  startedAt: Date
  completedAt?: Date
  transitionPeriod: number // in days
  createdBy: string
}

export interface ApiKeyRecord {
  _id: mongoose.Types.ObjectId
  id: string
  name: string
  accountId: string
  hashedKey: string
  type: ApiKeyType
  scopes: string[]
  createdAt: Date
  expiresAt: Date | null
  lastUsedAt: Date | null
  status: ApiKeyStatus
  tier: string
  metadata: Record<string, unknown>
  usageHistory: ApiKeyUsageRecord[]
  privateKey: string // for webhook signatures
  apiKeyRotation?: ApiKeyRotationRecord
}

const ApiKeyUsageSchema = new Schema<ApiKeyUsageRecord>({
  endpoint: {
    type: String,
    required: true,
  },
  ip: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
    required: true,
  },
  success: {
    type: Boolean,
    required: true,
  },
  responseTimeMs: {
    type: Number,
    required: true,
  },
  statusCode: {
    type: Number,
    required: true,
  },
})

const ApiKeyRotationSchema = new Schema<ApiKeyRotationRecord>({
  originalKeyId: {
    type: String,
    required: true,
  },
  newKeyId: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "in_progress", "completed", "failed"],
    required: true,
    default: "pending",
  },
  startedAt: {
    type: Date,
    default: Date.now,
    required: true,
  },
  completedAt: {
    type: Date,
  },
  transitionPeriod: {
    type: Number,
    required: true,
    default: 7, // default 7 days
  },
  createdBy: {
    type: String,
    required: true,
  },
})

const ApiKeySchema = new Schema<ApiKeyRecord>({
  id: {
    type: String,
    index: true,
    unique: true,
    required: true,
    default: () => crypto.randomUUID(),
  },
  name: {
    type: String,
    required: true,
    minlength: 3,
    maxlength: 100,
  },
  accountId: {
    type: String,
    required: true,
    index: true,
  },
  hashedKey: {
    type: String,
    required: true,
    unique: true,
  },
  type: {
    type: String,
    enum: Object.values(ApiKeyType),
    required: true,
    default: ApiKeyType.Test,
  },
  scopes: {
    type: [String],
    required: true,
    default: [],
  },
  createdAt: {
    type: Date,
    default: Date.now,
    required: true,
  },
  expiresAt: {
    type: Date,
    default: null,
  },
  lastUsedAt: {
    type: Date,
    default: null,
  },
  status: {
    type: String,
    enum: Object.values(ApiKeyStatus),
    required: true,
    default: ApiKeyStatus.Active,
    index: true,
  },
  tier: {
    type: String,
    required: true,
    default: "DEFAULT",
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {},
  },
  usageHistory: {
    type: [ApiKeyUsageSchema],
    default: [],
  },
  privateKey: {
    type: String,
    required: true,
  },
  apiKeyRotation: {
    type: ApiKeyRotationSchema,
    default: null,
  },
})

// Create indexes for efficient querying
ApiKeySchema.index({ accountId: 1, status: 1 })
ApiKeySchema.index({ hashedKey: 1, status: 1 })
ApiKeySchema.index({ createdAt: 1 })
ApiKeySchema.index({ expiresAt: 1 })
ApiKeySchema.index(
  { "usageHistory.timestamp": -1 },
  { 
    // Set expiration after 30 days
    expireAfterSeconds: 30 * 24 * 60 * 60,
    partialFilterExpression: { "usageHistory.timestamp": { $exists: true } } 
  }
)

export const ApiKey = mongoose.model<ApiKeyRecord>("ApiKey", ApiKeySchema)