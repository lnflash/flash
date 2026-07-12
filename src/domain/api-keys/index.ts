import { createHash, randomBytes } from "crypto"

import {
  InvalidApiKeyIpConstraintError,
  InvalidApiKeyNameError,
  InvalidApiKeyScopeError,
} from "./errors"

export * from "./errors"

// FIP-07 key format: fk_{keyId}_{randomSecret}
// keyId is hex (no base64url "_") so the key parses unambiguously;
// only the SHA-256 hash of the secret is persisted.
export const API_KEY_PREFIX = "fk"
export const API_KEY_ID_BYTES = 4 // → 8 hex chars
export const API_KEY_SECRET_BYTES = 48 // → 64 base64url chars

export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "read:wallet",
  "write:wallet",
  "read:transactions",
  "write:transactions",
  "read:user",
  "write:user",
  "admin",
]

export const API_KEY_STATUSES: readonly ApiKeyStatus[] = ["active", "revoked", "expired"]

export const hashApiKeySecret = (secret: string): ApiKeySecretHash =>
  createHash("sha256").update(secret).digest("hex") as ApiKeySecretHash

export const generateApiKey = (): GeneratedApiKey => {
  const keyId = randomBytes(API_KEY_ID_BYTES).toString("hex") as ApiKeyKeyId
  const secret = randomBytes(API_KEY_SECRET_BYTES).toString("base64url")
  return {
    keyId,
    secret,
    fullKey: `${API_KEY_PREFIX}_${keyId}_${secret}`,
    hashedSecret: hashApiKeySecret(secret),
  }
}

export const checkedToApiKeyName = (name: string): ApiKeyName | ValidationError => {
  if (!name || name.length < 3) {
    return new InvalidApiKeyNameError("API key name must be at least 3 characters")
  }
  if (name.length > 50) {
    return new InvalidApiKeyNameError("API key name must be less than 50 characters")
  }
  if (!/^[a-zA-Z0-9-_ ]+$/.test(name)) {
    return new InvalidApiKeyNameError(
      "API key name can only contain letters, numbers, spaces, hyphens, and underscores",
    )
  }
  return name as ApiKeyName
}

export const checkedToApiKeyScopes = (
  scopes: string[],
): ApiKeyScope[] | ValidationError => {
  if (!scopes || scopes.length < 1) {
    return new InvalidApiKeyScopeError("At least one scope is required")
  }
  for (const scope of scopes) {
    if (!(API_KEY_SCOPES as readonly string[]).includes(scope)) {
      return new InvalidApiKeyScopeError(`Invalid scope: ${scope}`)
    }
  }
  return scopes as ApiKeyScope[]
}

const IPV4_CIDR =
  /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(\/(3[0-2]|[12]?\d))?$/
const IPV6_CIDR = /^[0-9a-fA-F:]+(\/(12[0-8]|1[01]\d|\d?\d))?$/

export const checkedToApiKeyIpConstraints = (
  ips: string[],
): string[] | ValidationError => {
  for (const ip of ips) {
    if (!IPV4_CIDR.test(ip) && !IPV6_CIDR.test(ip)) {
      return new InvalidApiKeyIpConstraintError(`Invalid IP/CIDR constraint: ${ip}`)
    }
  }
  return ips
}

export const toApiKeyId = (id: string): ApiKeyId => id as ApiKeyId

export const toApiKeyKeyId = (keyId: string): ApiKeyKeyId => keyId as ApiKeyKeyId
