import { createApiKey } from "@app/api-keys"
import { ApiKeyCannotManageApiKeysError, isApiKeySessionId } from "@domain/api-keys"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import ApiKeyCreated from "@graphql/public/types/object/api-key-created"
import ApiKeyScope from "@graphql/public/types/scalar/api-key-scope"
import IError from "@graphql/shared/types/abstract/error"

const ApiKeyCreateInput = GT.Input({
  name: "ApiKeyCreateInput",
  fields: () => ({
    name: {
      type: GT.NonNull(GT.String),
      description:
        "A descriptive name for the API key (e.g., 'BTCPayServer Integration')",
    },
    scopes: {
      type: GT.List(GT.NonNull(ApiKeyScope)),
      defaultValue: ["read:user"],
      description: "Permission scopes for the key. Defaults to read-only user access.",
    },
    expiresIn: {
      type: GT.Int,
      description:
        "Optional expiration time in seconds. If not set, the key doesn't expire.",
    },
  }),
})

const ApiKeyCreatePayload = GT.Object({
  name: "ApiKeyCreatePayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    apiKey: { type: ApiKeyCreated },
  }),
})

const ApiKeyCreateMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(ApiKeyCreatePayload),
  description:
    "Generate a new API key for external service authentication. The raw key is only shown once and cannot be retrieved later.",
  args: {
    input: { type: GT.NonNull(ApiKeyCreateInput) },
  },
  resolve: async (_, args, { domainAccount, sessionId }: GraphQLPublicContextAuth) => {
    // Keys cannot mint or manage keys — management requires a kratos session
    if (isApiKeySessionId(sessionId)) {
      return {
        errors: [mapAndParseErrorForGqlResponse(new ApiKeyCannotManageApiKeysError())],
        apiKey: null,
      }
    }

    const result = await createApiKey({
      accountId: domainAccount.id,
      name: args.input.name,
      scopes: args.input.scopes || ["read:user"],
      expiresIn: args.input.expiresIn || null,
    })

    if (result instanceof Error) {
      return {
        errors: [mapAndParseErrorForGqlResponse(result)],
        apiKey: null,
      }
    }

    return { errors: [], apiKey: result }
  },
})

export default ApiKeyCreateMutation
