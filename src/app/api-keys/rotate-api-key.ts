import { ApiKeyExpiredError, generateApiKey } from "@domain/api-keys"
import { DomainError } from "@domain/shared"
import { auditApiKeyRotated } from "@services/api-keys-audit"
import { ApiKeysRepository } from "@services/mongoose/api-keys"
import { addAttributesToCurrentSpan } from "@services/tracing"

// Create-first rotation: the replacement key is persisted before the old one
// is revoked, so a failure never leaves the account without a working key.
// Deliberately bypasses the per-account limit check — net count is unchanged.
export const rotateApiKey = async ({
  id,
  accountId,
}: {
  id: ApiKeyId
  accountId: AccountId
}): Promise<RotatedApiKey | DomainError> => {
  addAttributesToCurrentSpan({ "app.apiKeys.rotate.id": id })

  const apiKeysRepo = ApiKeysRepository()

  const oldKey = await apiKeysRepo.findActiveByIdForAccount({ id, accountId })
  if (oldKey instanceof Error) {
    return oldKey
  }

  if (oldKey.expiresAt && oldKey.expiresAt.getTime() <= Date.now()) {
    return new ApiKeyExpiredError(oldKey.keyId)
  }

  const generated = generateApiKey()

  // Same name, scopes, constraints, rate limit, and absolute expiry — only
  // the secret (and its public keyId) change
  const newKey = await apiKeysRepo.create({
    keyId: generated.keyId,
    accountId,
    name: oldKey.name,
    hashedKey: generated.hashedSecret,
    scopes: oldKey.scopes,
    ipConstraints: oldKey.ipConstraints,
    metadata: oldKey.metadata,
    rateLimitPerMinute: oldKey.rateLimitPerMinute,
    expiresAt: oldKey.expiresAt,
  })
  if (newKey instanceof Error) {
    return newKey
  }

  const revoked = await apiKeysRepo.revoke({ id: oldKey.id, accountId })
  if (revoked instanceof Error) {
    // Compensate: never leave two active keys behind on a failed rotation
    await apiKeysRepo.revoke({ id: newKey.id, accountId })
    return revoked
  }

  addAttributesToCurrentSpan({
    "app.apiKeys.rotate.newKeyId": newKey.keyId,
    "app.apiKeys.rotate.revokedKeyId": oldKey.keyId,
  })

  auditApiKeyRotated({ accountId, oldKeyId: oldKey.keyId, newKeyId: newKey.keyId })

  return {
    id: newKey.id,
    keyId: newKey.keyId,
    name: newKey.name,
    apiKey: generated.fullKey,
    scopes: newKey.scopes,
    rateLimitPerMinute: newKey.rateLimitPerMinute,
    expiresAt: newKey.expiresAt,
    warning: "Store this key securely. It won't be shown again.",
    revokedKeyId: oldKey.keyId,
  }
}
