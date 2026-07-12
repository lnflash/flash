import { getApiKeyConfig } from "@config"
import {
  MaxApiKeysPerAccountError,
  checkedToApiKeyIpConstraints,
  checkedToApiKeyName,
  checkedToApiKeyRateLimit,
  checkedToApiKeyScopes,
  generateApiKey,
} from "@domain/api-keys"
import { DomainError } from "@domain/shared"
import { auditApiKeyCreated } from "@services/api-keys-audit"
import { ApiKeysRepository } from "@services/mongoose/api-keys"
import { addAttributesToCurrentSpan } from "@services/tracing"

export const createApiKey = async ({
  accountId,
  name,
  scopes = ["read:user"],
  ipConstraints = [],
  metadata = {},
  rateLimitPerMinute = null,
  expiresIn = null,
}: CreateApiKeyArgs): Promise<CreateApiKeyResult | DomainError> => {
  addAttributesToCurrentSpan({
    "app.apiKeys.create.accountId": accountId,
    "app.apiKeys.create.name": name,
    "app.apiKeys.create.scopes": scopes.join(","),
    "app.apiKeys.create.expiresIn": expiresIn || undefined,
  })

  const checkedName = checkedToApiKeyName(name)
  if (checkedName instanceof Error) {
    return checkedName
  }

  // Fine-grained scopes, at least one required
  const checkedScopes = checkedToApiKeyScopes(scopes)
  if (checkedScopes instanceof Error) {
    return checkedScopes
  }

  // IP constraints — single IPs or CIDR ranges
  const checkedIpConstraints = checkedToApiKeyIpConstraints(ipConstraints)
  if (checkedIpConstraints instanceof Error) {
    return checkedIpConstraints
  }

  // Per-key request rate limit — null keeps the platform default
  let checkedRateLimit: number | null = null
  if (rateLimitPerMinute !== null && rateLimitPerMinute !== undefined) {
    const checked = checkedToApiKeyRateLimit(rateLimitPerMinute)
    if (checked instanceof Error) {
      return checked
    }
    checkedRateLimit = checked
  }

  // Enforce per-account key limit (prevent abuse)
  const apiKeysRepo = ApiKeysRepository()
  const existingKeys = await apiKeysRepo.findByAccountId(accountId)
  if (existingKeys instanceof Error) {
    return existingKeys
  }

  const { maxKeysPerAccount } = getApiKeyConfig()
  if (existingKeys.length >= maxKeysPerAccount) {
    return new MaxApiKeysPerAccountError(
      `Maximum number of API keys (${maxKeysPerAccount}) reached. Please revoke unused keys.`,
    )
  }

  const { keyId, fullKey, hashedSecret } = generateApiKey()

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null // Default: no expiration

  const apiKey = await apiKeysRepo.create({
    keyId,
    accountId,
    name: checkedName,
    hashedKey: hashedSecret,
    scopes: checkedScopes,
    ipConstraints: checkedIpConstraints,
    metadata,
    rateLimitPerMinute: checkedRateLimit,
    expiresAt,
  })

  if (apiKey instanceof Error) {
    addAttributesToCurrentSpan({ "app.apiKeys.create.error": true })
    return apiKey
  }

  addAttributesToCurrentSpan({
    "app.apiKeys.create.success": true,
    "app.apiKeys.create.keyId": apiKey.keyId,
  })

  auditApiKeyCreated({
    accountId,
    keyId: apiKey.keyId,
    scopes: apiKey.scopes,
    expiresAt: apiKey.expiresAt,
    rateLimitPerMinute: apiKey.rateLimitPerMinute,
  })

  // The raw key is returned exactly once — only its hash is persisted
  return {
    id: apiKey.id,
    keyId: apiKey.keyId,
    name: apiKey.name,
    apiKey: fullKey,
    scopes: apiKey.scopes,
    rateLimitPerMinute: apiKey.rateLimitPerMinute,
    expiresAt: apiKey.expiresAt,
    warning: "Store this key securely. It won't be shown again.",
  }
}
