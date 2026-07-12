import { revokeApiKey } from "@app/api-keys"
import { ApiKeyCannotManageApiKeysError, isApiKeySessionId } from "@domain/api-keys"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import ApiKeyObject from "@graphql/public/types/object/api-key"
import IError from "@graphql/shared/types/abstract/error"

const ApiKeyRevokeInput = GT.Input({
  name: "ApiKeyRevokeInput",
  fields: () => ({
    id: { type: GT.NonNullID },
  }),
})

const ApiKeyRevokePayload = GT.Object({
  name: "ApiKeyRevokePayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    apiKey: { type: ApiKeyObject },
  }),
})

const ApiKeyRevokeMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(ApiKeyRevokePayload),
  description:
    "Revoke an API key. Verification stops honoring it immediately; this cannot be undone.",
  args: {
    input: { type: GT.NonNull(ApiKeyRevokeInput) },
  },
  resolve: async (_, args, { domainAccount, sessionId }: GraphQLPublicContextAuth) => {
    // Keys cannot manage keys — management requires a kratos session
    if (isApiKeySessionId(sessionId)) {
      return {
        errors: [mapAndParseErrorForGqlResponse(new ApiKeyCannotManageApiKeysError())],
        apiKey: null,
      }
    }

    const revoked = await revokeApiKey({
      id: args.input.id as ApiKeyId,
      accountId: domainAccount.id,
    })

    if (revoked instanceof Error) {
      return {
        errors: [mapAndParseErrorForGqlResponse(revoked)],
        apiKey: null,
      }
    }

    return { errors: [], apiKey: revoked }
  },
})

export default ApiKeyRevokeMutation
