type ApiKeyId = string & { readonly brand: unique symbol }
type AccountId = string & { readonly brand: unique symbol }

type ApiKeyCreateParams = {
  name: string
  accountId: AccountId
  type: import(".").ApiKeyType
  scopes: import(".").Scope[]
  expiresAt?: Date
  tier?: string
  metadata?: Record<string, unknown>
}

type ApiKeyUpdateParams = {
  id: ApiKeyId
  name?: string
  scopes?: import(".").Scope[]
  expiresAt?: Date | null
  tier?: string
  metadata?: Record<string, unknown>
}

type ApiKeyVerifyParams = {
  apiKey: string
  requiredScopes?: import(".").Scope[]
}

type ApiKeyRotateParams = {
  id: ApiKeyId
  transitionPeriodDays?: number
}

type ApiKeyRotationStatus = {
  originalKeyId: ApiKeyId
  newKeyId: ApiKeyId
  status: "pending" | "in_progress" | "completed" | "failed"
  startedAt: Date
  completedAt?: Date
  transitionPeriod: number
}

type ApiKeyWithUsage = import(".").ApiKey & {
  usageStats: {
    totalRequests: number
    requestsLast24h: number
    lastRequests: {
      timestamp: Date
      endpoint: string
      ip: string
      success: boolean
    }[]
  }
}

type ApiKeyLookupByKeyResult = {
  id: ApiKeyId
  accountId: AccountId
  hashedKey: string
  scopes: import(".").Scope[]
  status: import(".").ApiKeyStatus
  expiresAt: Date | null
  tier: string
}

type ApiKeySignature = {
  signature: string
  timestamp: number
  apiKeyId: ApiKeyId
}