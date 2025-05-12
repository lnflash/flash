import { generateKeyPairSync } from "crypto"

export enum ApiKeyType {
  Test = "test",
  Live = "live",
}

export enum ApiKeyStatus {
  Active = "active",
  Revoked = "revoked",
  Expired = "expired",
  Rotating = "rotating",
}

export enum ScopeType {
  Read = "read",
  Write = "write",
  All = "all",
}

export enum ResourceType {
  Account = "account",
  Wallet = "wallet",
  Transaction = "transaction",
  Lightning = "lightning",
  OnChain = "onchain",
  Price = "price",
  Cashout = "cashout",
  Webhook = "webhook",
  User = "user",
  Admin = "admin",
}

export const SCOPE_SEPARATOR = ":"
export const API_KEY_PREFIX_SEPARATOR = "_"

export const API_KEY_PREFIX = {
  [ApiKeyType.Test]: "flash_test",
  [ApiKeyType.Live]: "flash_live",
}

export type Scope = `${ScopeType}:${ResourceType}` | `${ScopeType}:${ResourceType}:${string}`

export const ALL_SCOPES: Scope[] = Object.values(ResourceType).map(
  (resource) => `${ScopeType.All}:${resource}`
)

export const READ_SCOPES: Scope[] = Object.values(ResourceType).map(
  (resource) => `${ScopeType.Read}:${resource}`
)

export const WRITE_SCOPES: Scope[] = Object.values(ResourceType).map(
  (resource) => `${ScopeType.Write}:${resource}`
)

export const COMMON_SCOPES: Scope[] = [
  "read:account",
  "read:wallet",
  "read:transaction",
  "read:price",
  "write:webhook",
]

export type ApiKey = {
  id: string
  name: string
  accountId: string
  type: ApiKeyType
  scopes: Scope[]
  expiresAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
  status: ApiKeyStatus
  tier: string
  metadata: Record<string, unknown>
}

export type ApiKeyWithHash = ApiKey & {
  hashedKey: string
}

export type ApiKeyWithSecrets = ApiKey & {
  apiKey: string
  privateKey: string
}

export const ApiKeyIdRegex = /^[0-9a-f]{24}$/

// Returns true if the scope is valid for the given resource
export const isValidScope = (scope: string): scope is Scope => {
  const [type, resource] = scope.split(SCOPE_SEPARATOR)
  
  if (!type || !resource) {
    return false
  }
  
  const scopeType = type as ScopeType
  const resourceType = resource as ResourceType
  
  return Object.values(ScopeType).includes(scopeType) && 
         Object.values(ResourceType).includes(resourceType)
}

// Generate a set of key credentials for API key creation
export const generateApiKeyCredentials = (
  type: ApiKeyType,
  size = 32,
): { apiKey: string; hashedKey: string; privateKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  })

  // Generate a random string for the API key
  const randomBytes = Buffer.from(Array(size).fill(0).map(() => Math.floor(Math.random() * 256)))
  const keySegment = randomBytes.toString("base64url")
  
  // Combine prefix with random bytes
  const apiKey = `${API_KEY_PREFIX[type]}${API_KEY_PREFIX_SEPARATOR}${keySegment}`
  
  // Use public key as hashed key - it's derived from private key but can't be reversed
  const hashedKey = publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g, "")
  
  return {
    apiKey,
    hashedKey,
    privateKey,
  }
}