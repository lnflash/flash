// Use string as a branded type for AccountId
export type AccountId = string & { readonly brand: unique symbol }
import { ApiKeyStatus, ApiKeyType, Scope } from "."

// API key specific branded type
export type ApiKeyId = string & { readonly brand: unique symbol }

export type ApiKeyCreateParams = {
  name: string
  accountId: AccountId
  type: ApiKeyType
  scopes: Scope[]
  expiresAt?: Date
  tier?: string
  metadata?: Record<string, unknown>
}

export type ApiKeyUpdateParams = {
  id: ApiKeyId
  name?: string
  scopes?: Scope[]
  expiresAt?: Date | null
  tier?: string
  metadata?: Record<string, unknown>
}

export type ApiKeyVerifyParams = {
  apiKey: string
  requiredScopes?: Scope[]
}

export type ApiKeyRotateParams = {
  id: ApiKeyId
  transitionPeriodDays?: number
}

export type ApiKeyRotationStatus = {
  originalKeyId: ApiKeyId
  newKeyId: ApiKeyId
  status: "pending" | "in_progress" | "completed" | "failed"
  startedAt: Date
  completedAt?: Date
  transitionPeriod: number
}

export type ApiKeyLookupByKeyResult = {
  id: ApiKeyId
  accountId: AccountId
  hashedKey: string
  scopes: Scope[]
  status: ApiKeyStatus
  expiresAt: Date | null
  tier: string
}

export type ApiKeySignature = {
  signature: string
  timestamp: number
  apiKeyId: ApiKeyId
}