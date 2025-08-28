import { Schema, model } from "mongoose"
import { 
  ApiTokenId,
  ApiTokenHash,
  ApiTokenName,
  ApiTokenScope,
  IApiToken,
  NewApiToken,
  toApiTokenId,
  toApiTokenHash
} from "@domain/api-tokens/index.types"
// AccountId is a global type from domain/primitives/index.types.d.ts
import { 
  CouldNotFindError,
  RepositoryError,
  UnknownRepositoryError 
} from "@domain/errors"
import { toObjectId, fromObjectId } from "@services/mongoose/utils"

// MongoDB Schema
const ApiTokenSchema = new Schema({
  _id: { type: Schema.Types.ObjectId, auto: true },
  accountId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  scopes: [{ type: String, enum: ["read", "write", "admin"] }],
  lastUsed: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
})

// Compound index for efficient queries
ApiTokenSchema.index({ accountId: 1, active: 1 })
ApiTokenSchema.index({ tokenHash: 1, active: 1 })

const ApiTokenModel = model("ApiToken", ApiTokenSchema)

// Translation functions
const translateToApiToken = (doc: any): IApiToken => {
  return {
    id: toApiTokenId(fromObjectId(doc._id)),
    accountId: doc.accountId as AccountId,
    name: doc.name as ApiTokenName,
    tokenHash: toApiTokenHash(doc.tokenHash),
    scopes: doc.scopes as ApiTokenScope[],
    lastUsed: doc.lastUsed,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    active: doc.active
  }
}

// Repository interface
export interface IApiTokensRepository {
  create(token: NewApiToken): Promise<IApiToken | RepositoryError>
  findByTokenHash(hash: ApiTokenHash): Promise<IApiToken | RepositoryError>
  findByAccountId(accountId: AccountId): Promise<IApiToken[] | RepositoryError>
  updateLastUsed(id: ApiTokenId): Promise<void | RepositoryError>
  revoke(id: ApiTokenId): Promise<IApiToken | RepositoryError>
  revokeAll(accountId: AccountId): Promise<number | RepositoryError>
}

// Repository implementation
export const ApiTokensRepository = (): IApiTokensRepository => {
  return {
    create: async (token: NewApiToken): Promise<IApiToken | RepositoryError> => {
      try {
        const doc = await ApiTokenModel.create({
          accountId: token.accountId,
          name: token.name,
          tokenHash: token.tokenHash,
          scopes: token.scopes,
          expiresAt: token.expiresAt,
          active: true
        })
        
        return translateToApiToken(doc)
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    findByTokenHash: async (hash: ApiTokenHash): Promise<IApiToken | RepositoryError> => {
      try {
        const doc = await ApiTokenModel.findOne({ 
          tokenHash: hash,
          active: true 
        })
        
        if (!doc) {
          return new CouldNotFindError("API token not found")
        }
        
        return translateToApiToken(doc)
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    findByAccountId: async (accountId: AccountId): Promise<IApiToken[] | RepositoryError> => {
      try {
        const docs = await ApiTokenModel.find({ 
          accountId,
          active: true 
        }).sort({ createdAt: -1 })
        
        return docs.map(translateToApiToken)
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    updateLastUsed: async (id: ApiTokenId): Promise<void | RepositoryError> => {
      try {
        await ApiTokenModel.updateOne(
          { _id: toObjectId(id) },
          { $set: { lastUsed: new Date() } }
        )
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    revoke: async (id: ApiTokenId): Promise<IApiToken | RepositoryError> => {
      try {
        const doc = await ApiTokenModel.findOneAndUpdate(
          { _id: toObjectId(id) },
          { $set: { active: false } },
          { new: true }
        )
        
        if (!doc) {
          return new CouldNotFindError("API token not found")
        }
        
        return translateToApiToken(doc)
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    },

    revokeAll: async (accountId: AccountId): Promise<number | RepositoryError> => {
      try {
        const result = await ApiTokenModel.updateMany(
          { accountId, active: true },
          { $set: { active: false } }
        )
        
        return result.modifiedCount
      } catch (err) {
        return new UnknownRepositoryError(err)
      }
    }
  }
}