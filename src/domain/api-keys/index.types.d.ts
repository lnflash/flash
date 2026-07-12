type ApiKeyId = string & { readonly brand: unique symbol }
type ApiKeyKeyId = string & { readonly brand: unique symbol }
type ApiKeySecretHash = string & { readonly brand: unique symbol }
type ApiKeyName = string & { readonly brand: unique symbol }

type ApiKeyScope =
  | "read:wallet"
  | "write:wallet"
  | "read:transactions"
  | "write:transactions"
  | "read:user"
  | "write:user"
  | "admin"

type ApiKeyStatus = "active" | "revoked" | "expired"

type ApiKey = {
  id: ApiKeyId
  // 8-char public lookup id (the {keyId} in fk_{keyId}_{secret})
  keyId: ApiKeyKeyId
  accountId: AccountId
  name: ApiKeyName
  // SHA-256 hash of the secret only — the secret itself is never stored
  hashedKey: ApiKeySecretHash
  scopes: ApiKeyScope[]
  status: ApiKeyStatus
  // IP whitelisting — single IPs or CIDR ranges
  ipConstraints: string[]
  metadata: Record<string, unknown>
  lastUsedAt: Date | null
  createdAt: Date
  expiresAt: Date | null
}

type NewApiKey = {
  keyId: ApiKeyKeyId
  accountId: AccountId
  name: ApiKeyName
  hashedKey: ApiKeySecretHash
  scopes: ApiKeyScope[]
  ipConstraints?: string[]
  metadata?: Record<string, unknown>
  expiresAt: Date | null
}

type GeneratedApiKey = {
  keyId: ApiKeyKeyId
  secret: string
  // Full key handed to the caller exactly once: fk_{keyId}_{secret}
  fullKey: string
  hashedSecret: ApiKeySecretHash
}

type CreateApiKeyArgs = {
  accountId: AccountId
  name: string
  scopes?: ApiKeyScope[]
  ipConstraints?: string[]
  metadata?: Record<string, unknown>
  expiresIn?: number | null // seconds until expiration
}

type CreateApiKeyResult = {
  id: ApiKeyId
  keyId: ApiKeyKeyId
  name: ApiKeyName
  apiKey: string // Raw key (fk_{keyId}_{secret}), only returned once
  scopes: ApiKeyScope[]
  expiresAt: Date | null
  warning: string
}

interface IApiKeysRepository {
  create(apiKey: NewApiKey): Promise<ApiKey | RepositoryError>
  findByKeyId(keyId: ApiKeyKeyId): Promise<ApiKey | RepositoryError>
  findByAccountId(accountId: AccountId): Promise<ApiKey[] | RepositoryError>
  updateLastUsedAt(id: ApiKeyId): Promise<void | RepositoryError>
  revoke(id: ApiKeyId): Promise<ApiKey | RepositoryError>
  revokeAll(accountId: AccountId): Promise<number | RepositoryError>
}
