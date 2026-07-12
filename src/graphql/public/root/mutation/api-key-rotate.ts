import { rotateApiKey } from "@app/api-keys"
import { ApiKeyCannotManageApiKeysError, isApiKeySessionId } from "@domain/api-keys"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import ApiKeyCreated from "@graphql/public/types/object/api-key-created"
import IError from "@graphql/shared/types/abstract/error"

const ApiKeyRotateInput = GT.Input({
  name: "ApiKeyRotateInput",
  fields: () => ({
    id: { type: GT.NonNullID },
  }),
})

const ApiKeyRotatePayload = GT.Object({
  name: "ApiKeyRotatePayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    apiKey: { type: ApiKeyCreated },
  }),
})

const ApiKeyRotateMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(ApiKeyRotatePayload),
  description:
    "Rotate an API key: a replacement with a new secret (and keyId) is created with the same name, scopes, and expiry, and the old key is revoked. The new raw key is only shown once.",
  args: {
    input: { type: GT.NonNull(ApiKeyRotateInput) },
  },
  resolve: async (_, args, { domainAccount, sessionId }: GraphQLPublicContextAuth) => {
    // Keys cannot manage keys — management requires a kratos session
    if (isApiKeySessionId(sessionId)) {
      return {
        errors: [mapAndParseErrorForGqlResponse(new ApiKeyCannotManageApiKeysError())],
        apiKey: null,
      }
    }

    const rotated = await rotateApiKey({
      id: args.input.id as ApiKeyId,
      accountId: domainAccount.id,
    })

    if (rotated instanceof Error) {
      return {
        errors: [mapAndParseErrorForGqlResponse(rotated)],
        apiKey: null,
      }
    }

    return { errors: [], apiKey: rotated }
  },
})

export default ApiKeyRotateMutation
