type ApiKeyCreateParams = {
  name: string
  accountId: string
  type: import("@domain/api-keys").ApiKeyType
  scopes: import("@domain/api-keys").Scope[]
  expiresAt?: Date
  tier?: string
  metadata?: Record<string, unknown>
}

type ApiKeyUpdateParams = {
  id: string
  name?: string
  scopes?: import("@domain/api-keys").Scope[]
  expiresAt?: Date | null
  tier?: string
  metadata?: Record<string, unknown>
}

type ApiKeyRotateParams = {
  id: string
  transitionPeriodDays?: number
}

type ApiKeyUsageParams = {
  apiKeyId: string
  endpoint: string
  ip: string
  success: boolean
  responseTimeMs: number
  statusCode: number
}

type WebhookSignatureParams = {
  apiKeyId: string
  payload: Record<string, unknown>
}

type WebhookSignatureVerifyParams = {
  apiKeyId: string
  payload: Record<string, unknown>
  signature: string
  timestamp: number
}

type WebhookSignatureResult = {
  signature: string
  timestamp: number
}

interface IApiKeyService {
  create(params: ApiKeyCreateParams): Promise<import("@domain/api-keys").ApiKeyWithSecrets>
  getById(id: string): Promise<import("@domain/api-keys").ApiKeyWithHash>
  listByAccountId(accountId: string): Promise<import("@domain/api-keys").ApiKey[]>
  verifyKey(
    apiKey: string,
    requiredScopes?: import("@domain/api-keys").Scope[],
  ): Promise<import("@domain/api-keys/index.types").ApiKeyLookupByKeyResult>
  update(params: ApiKeyUpdateParams): Promise<import("@domain/api-keys").ApiKey>
  revoke(id: string): Promise<boolean>
  initiateRotation(params: ApiKeyRotateParams): Promise<import("@domain/api-keys").ApiKeyWithSecrets>
  completeRotation(originalKeyId: string): Promise<boolean>
  logUsage(params: ApiKeyUsageParams): Promise<void>
  generateWebhookSignature(
    apiKeyId: string,
    payload: Record<string, unknown>,
  ): Promise<WebhookSignatureResult>
  verifyWebhookSignature(
    apiKeyId: string,
    payload: Record<string, unknown>,
    signature: string,
    timestamp: number,
  ): Promise<boolean>
}