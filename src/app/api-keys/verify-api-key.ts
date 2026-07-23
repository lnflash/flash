import {
  isApiKeySecretValid,
  isIpAllowedByConstraints,
  parseApiKey,
  ApiKeyExpiredError,
  ApiKeyIpNotAllowedError,
  ApiKeySecretMismatchError,
} from "@domain/api-keys"
import { DomainError } from "@domain/shared"
import { AccountsRepository } from "@services/mongoose"
import { ApiKeysRepository } from "@services/mongoose/api-keys"
import { addAttributesToCurrentSpan } from "@services/tracing"

// lastUsedAt is observability metadata, not an audit log — cap it at one
// write per key per minute so verification stays read-only on hot keys.
const LAST_USED_AT_THROTTLE_MS = 60_000

export const verifyApiKey = async ({
  rawKey,
  requestIp,
}: {
  rawKey: string
  requestIp?: string
}): Promise<VerifiedApiKey | DomainError> => {
  const parsed = parseApiKey(rawKey)
  if (parsed instanceof Error) {
    return parsed
  }

  addAttributesToCurrentSpan({ "app.apiKeys.verify.keyId": parsed.keyId })

  const apiKeysRepo = ApiKeysRepository()
  const apiKey = await apiKeysRepo.findByKeyId(parsed.keyId)
  if (apiKey instanceof Error) {
    return apiKey
  }

  if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
    return new ApiKeyExpiredError(apiKey.keyId)
  }

  if (!isApiKeySecretValid({ secret: parsed.secret, hashedKey: apiKey.hashedKey })) {
    return new ApiKeySecretMismatchError(apiKey.keyId)
  }

  if (apiKey.ipConstraints.length > 0) {
    // Fail closed: an IP-constrained key must never verify when the client
    // IP can't be determined.
    if (!requestIp) {
      return new ApiKeyIpNotAllowedError("client IP unavailable")
    }
    if (!isIpAllowedByConstraints({ ip: requestIp, constraints: apiKey.ipConstraints })) {
      return new ApiKeyIpNotAllowedError(requestIp)
    }
  }

  const account = await AccountsRepository().findById(apiKey.accountId)
  if (account instanceof Error) {
    return account
  }

  if (
    !apiKey.lastUsedAt ||
    Date.now() - apiKey.lastUsedAt.getTime() > LAST_USED_AT_THROTTLE_MS
  ) {
    // Fire-and-forget: a failed timestamp update must not fail verification
    // (updateLastUsedAt never rejects — repository errors are returned, not thrown)
    apiKeysRepo.updateLastUsedAt(apiKey.id)
  }

  addAttributesToCurrentSpan({ "app.apiKeys.verify.success": true })

  return { apiKey, kratosUserId: account.kratosUserId }
}
