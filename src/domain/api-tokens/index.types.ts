// AccountId is a global type from domain/primitives/index.types.d.ts

// Branded types for type safety
export type ApiTokenId = string & { readonly brand: unique symbol }
export type ApiToken = string & { readonly brand: unique symbol }
export type ApiTokenName = string & { readonly brand: unique symbol }
export type ApiTokenHash = string & { readonly brand: unique symbol }

// Token scopes
export type ApiTokenScope = "read" | "write" | "admin"

// Main API token interface
export interface IApiToken {
  id: ApiTokenId
  accountId: AccountId
  name: ApiTokenName
  tokenHash: ApiTokenHash
  scopes: ApiTokenScope[]
  lastUsed: Date | null
  createdAt: Date
  expiresAt: Date | null
  active: boolean
}

// Creation types
export interface NewApiToken {
  accountId: AccountId
  name: ApiTokenName
  tokenHash: ApiTokenHash
  scopes: ApiTokenScope[]
  expiresAt: Date | null
}

export interface CreateApiTokenArgs {
  accountId: AccountId
  name: string
  scopes?: ApiTokenScope[]
  expiresIn?: number | null // seconds until expiration
}

export interface CreateApiTokenResult {
  id: ApiTokenId
  name: ApiTokenName
  token: string // Raw token, only returned once
  scopes: ApiTokenScope[]
  expiresAt: Date | null
  warning: string
}

// Validation functions
export const checkedToApiTokenName = (name: string): ApiTokenName | Error => {
  if (!name || name.length < 3) {
    return new Error("API token name must be at least 3 characters")
  }
  if (name.length > 50) {
    return new Error("API token name must be less than 50 characters")
  }
  if (!/^[a-zA-Z0-9-_ ]+$/.test(name)) {
    return new Error("API token name can only contain letters, numbers, spaces, hyphens, and underscores")
  }
  return name as ApiTokenName
}

export const toApiTokenId = (id: string): ApiTokenId => {
  return id as ApiTokenId
}

export const toApiTokenHash = (hash: string): ApiTokenHash => {
  return hash as ApiTokenHash
}