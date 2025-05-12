import { ApiKey, ApiKeyWithHash, ApiKeyWithSecrets, Scope } from "@domain/api-keys"
import { 
  ApiKeyCreateParams as DomainApiKeyCreateParams,
  ApiKeyUpdateParams as DomainApiKeyUpdateParams,
  ApiKeyRotateParams as DomainApiKeyRotateParams,
  ApiKeyLookupByKeyResult 
} from "@domain/api-keys/types"

// Service-specific variants of domain types
export type ApiKeyCreateParams = Omit<DomainApiKeyCreateParams, 'accountId'> & {
  accountId: string // Use string instead of AccountId branded type
}

export type ApiKeyUpdateParams = Omit<DomainApiKeyUpdateParams, 'id'> & {
  id: string // Use string instead of ApiKeyId branded type
}

export type ApiKeyRotateParams = Omit<DomainApiKeyRotateParams, 'id'> & {
  id: string // Use string instead of ApiKeyId branded type
}

export type ApiKeyUsageParams = {
  apiKeyId: string
  endpoint: string
  ip: string
  success: boolean
  responseTimeMs: number
  statusCode: number
}

export type WebhookSignatureParams = {
  apiKeyId: string
  payload: Record<string, unknown>
}

export type WebhookSignatureVerifyParams = {
  apiKeyId: string
  payload: Record<string, unknown>
  signature: string
  timestamp: number
}

export type WebhookSignatureResult = {
  signature: string
  timestamp: number
}

export interface IApiKeyService {
  create(params: ApiKeyCreateParams): Promise<ApiKeyWithSecrets>
  getById(id: string): Promise<ApiKeyWithHash>
  listByAccountId(accountId: string): Promise<ApiKey[]>
  verifyKey(
    apiKey: string,
    requiredScopes?: Scope[],
  ): Promise<ApiKeyLookupByKeyResult>
  update(params: ApiKeyUpdateParams): Promise<ApiKey>
  revoke(id: string): Promise<boolean>
  initiateRotation(params: ApiKeyRotateParams): Promise<ApiKeyWithSecrets>
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