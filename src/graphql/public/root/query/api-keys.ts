import { listApiKeys } from "@app/api-keys"
import { ApiKeyCannotManageApiKeysError, isApiKeySessionId } from "@domain/api-keys"
import { mapError } from "@graphql/error-map"
import { GT } from "@graphql/index"
import ApiKeyObject from "@graphql/public/types/object/api-key"
import { incApiKeyManagement } from "@services/api-keys-metrics"

const ApiKeysQuery = GT.Field({
  type: GT.NonNullList(ApiKeyObject),
  description:
    "All API keys for the calling account, newest first. Never includes secret material.",
  resolve: async (_, __, { domainAccount, sessionId }: GraphQLPublicContextAuth) => {
    // Keys cannot enumerate keys — management requires a kratos session
    if (isApiKeySessionId(sessionId)) {
      incApiKeyManagement("list", "failure")
      throw mapError(new ApiKeyCannotManageApiKeysError())
    }

    const apiKeys = await listApiKeys({ accountId: domainAccount.id })
    if (apiKeys instanceof Error) {
      incApiKeyManagement("list", "failure")
      throw mapError(apiKeys)
    }

    incApiKeyManagement("list", "success")
    return apiKeys
  },
})

export default ApiKeysQuery
