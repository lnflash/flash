import { Schema, Types, model } from "mongoose"

import {
  API_KEY_SCOPES,
  API_KEY_STATUSES,
  toApiKeyId,
  toApiKeyKeyId,
} from "@domain/api-keys"
import { CouldNotFindError, UnknownRepositoryError } from "@domain/errors"
import { fromObjectId, toObjectId } from "@services/mongoose/utils"

// MongoDB Schema — FIP-07 ApiKey data model
const ApiKeySchema = new Schema({
  _id: { type: Schema.Types.ObjectId, auto: true },
  // 8-char public lookup id (the {keyId} in fk_{keyId}_{secret})
  keyId: { type: String, required: true, unique: true },
  accountId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  // SHA-256 hash of the secret only — the secret itself is never stored
  hashedKey: { type: String, required: true, unique: true },
  scopes: {
    type: [{ type: String, enum: [...API_KEY_SCOPES] }],
    validate: {
      validator: (v: string[]) => Array.isArray(v) && v.length > 0,
      message: "At least one scope is required",
    },
  },
  status: {
    type: String,
    enum: [...API_KEY_STATUSES],
    default: "active",
    index: true,
  },
  // IP whitelisting — single IPs or CIDR ranges
  ipConstraints: { type: [String], default: [] },
  metadata: { type: Schema.Types.Mixed, default: {} },
  // Requests/minute for this key; null → platform default applies
  rateLimitPerMinute: { type: Number, default: null, min: 1, max: 10000 },
  lastUsedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
})

// Compound index for efficient per-account active-key lookups
ApiKeySchema.index({ accountId: 1, status: 1 })

export const ApiKeyModel = model("ApiKey", ApiKeySchema)

interface ApiKeyDocument {
  _id: Types.ObjectId
  keyId: string
  accountId: string
  name: string
  hashedKey: string
  scopes: string[]
  status: string
  ipConstraints: string[]
  metadata: Record<string, unknown>
  rateLimitPerMinute: number | null
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
}

const translateToApiKey = (doc: ApiKeyDocument): ApiKey => {
  return {
    id: toApiKeyId(fromObjectId(doc._id)),
    keyId: toApiKeyKeyId(doc.keyId),
    accountId: doc.accountId as AccountId,
    name: doc.name as ApiKeyName,
    hashedKey: doc.hashedKey as ApiKeySecretHash,
    scopes: doc.scopes as ApiKeyScope[],
    status: doc.status as ApiKeyStatus,
    ipConstraints: doc.ipConstraints ?? [],
    metadata: (doc.metadata ?? {}) as Record<string, unknown>,
    rateLimitPerMinute: doc.rateLimitPerMinute ?? null,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
  }
}

export const ApiKeysRepository = (): IApiKeysRepository => {
  return {
    create: async (apiKey: NewApiKey): Promise<ApiKey | RepositoryError> => {
      try {
        const doc = await ApiKeyModel.create({
          keyId: apiKey.keyId,
          accountId: apiKey.accountId,
          name: apiKey.name,
          hashedKey: apiKey.hashedKey,
          scopes: apiKey.scopes,
          ipConstraints: apiKey.ipConstraints ?? [],
          metadata: apiKey.metadata ?? {},
          rateLimitPerMinute: apiKey.rateLimitPerMinute,
          expiresAt: apiKey.expiresAt,
          status: "active",
        })

        return translateToApiKey(doc)
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    findByKeyId: async (keyId: ApiKeyKeyId): Promise<ApiKey | RepositoryError> => {
      try {
        const doc = await ApiKeyModel.findOne({ keyId, status: "active" })

        if (!doc) {
          return new CouldNotFindError("API key not found")
        }

        return translateToApiKey(doc)
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    findByAccountId: async (
      accountId: AccountId,
    ): Promise<ApiKey[] | RepositoryError> => {
      try {
        const docs = await ApiKeyModel.find({
          accountId,
          status: "active",
        }).sort({ createdAt: -1 })

        return docs.map((doc) => translateToApiKey(doc))
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    listByAccountId: async (
      accountId: AccountId,
    ): Promise<ApiKey[] | RepositoryError> => {
      try {
        const docs = await ApiKeyModel.find({ accountId }).sort({ createdAt: -1 })

        return docs.map((doc) => translateToApiKey(doc))
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    findActiveByIdForAccount: async ({
      id,
      accountId,
    }: {
      id: ApiKeyId
      accountId: AccountId
    }): Promise<ApiKey | RepositoryError> => {
      try {
        const doc = await ApiKeyModel.findOne({
          _id: toObjectId(id),
          accountId,
          status: "active",
        })

        if (!doc) {
          return new CouldNotFindError("API key not found")
        }

        return translateToApiKey(doc)
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    updateLastUsedAt: async (id: ApiKeyId): Promise<void | RepositoryError> => {
      try {
        await ApiKeyModel.updateOne(
          { _id: toObjectId(id) },
          { $set: { lastUsedAt: new Date() } },
        )
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    revoke: async ({
      id,
      accountId,
    }: {
      id: ApiKeyId
      accountId: AccountId
    }): Promise<ApiKey | RepositoryError> => {
      try {
        const doc = await ApiKeyModel.findOneAndUpdate(
          { _id: toObjectId(id), accountId },
          { $set: { status: "revoked" } },
          { new: true },
        )

        if (!doc) {
          return new CouldNotFindError("API key not found")
        }

        return translateToApiKey(doc)
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    revokeAll: async (accountId: AccountId): Promise<number | RepositoryError> => {
      try {
        const result = await ApiKeyModel.updateMany(
          { accountId, status: "active" },
          { $set: { status: "revoked" } },
        )

        return result.modifiedCount
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },
  }
}
