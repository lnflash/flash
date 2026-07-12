import { DomainError } from "@domain/shared"
import { auditApiKeyRevoked } from "@services/api-keys-audit"
import { ApiKeysRepository } from "@services/mongoose/api-keys"
import { addAttributesToCurrentSpan } from "@services/tracing"

export const revokeApiKey = async ({
  id,
  accountId,
}: {
  id: ApiKeyId
  accountId: AccountId
}): Promise<ApiKey | DomainError> => {
  addAttributesToCurrentSpan({ "app.apiKeys.revoke.id": id })

  // Account-scoped in the repository — a caller can only revoke its own keys
  const revoked = await ApiKeysRepository().revoke({ id, accountId })
  if (revoked instanceof Error) {
    return revoked
  }

  addAttributesToCurrentSpan({ "app.apiKeys.revoke.keyId": revoked.keyId })
  auditApiKeyRevoked({ accountId, keyId: revoked.keyId })
  return revoked
}
