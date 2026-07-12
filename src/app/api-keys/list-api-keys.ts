import { DomainError } from "@domain/shared"
import { ApiKeysRepository } from "@services/mongoose/api-keys"

export const listApiKeys = async ({
  accountId,
}: {
  accountId: AccountId
}): Promise<ApiKey[] | DomainError> => {
  return ApiKeysRepository().listByAccountId(accountId)
}
