import { GT } from "@graphql/index"
// GraphQLPublicContextAuth is a global type
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { createApiToken } from "@app/api-tokens/create-api-token"
import ApiTokenScope from "@graphql/public/types/scalar/api-token-scope"
import IError from "@graphql/shared/types/abstract/error"

const ApiTokenCreateInput = GT.Input({
  name: "ApiTokenCreateInput",
  fields: () => ({
    name: { 
      type: GT.NonNull(GT.String),
      description: "A descriptive name for the API token (e.g., 'BTCPayServer Integration')"
    },
    scopes: { 
      type: GT.List(GT.NonNull(ApiTokenScope)), 
      defaultValue: ["read"],
      description: "Permission scopes for the token. Defaults to read-only access."
    },
    expiresIn: {
      type: GT.Int,
      description: "Optional expiration time in seconds. If not set, token doesn't expire."
    }
  })
})

const ApiTokenCreatePayload = GT.Object({
  name: "ApiTokenCreatePayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError)
    },
    apiToken: {
      type: GT.Object({
        name: "ApiTokenCreated",
        fields: () => ({
          id: { type: GT.NonNull(GT.String) },
          name: { type: GT.NonNull(GT.String) },
          token: { 
            type: GT.NonNull(GT.String),
            description: "The actual API token. Store this securely as it won't be shown again."
          },
          scopes: { type: GT.NonNullList(ApiTokenScope) },
          expiresAt: { type: GT.String },
          warning: { 
            type: GT.NonNull(GT.String),
            description: "Important message about token security"
          }
        })
      })
    }
  })
})

const ApiTokenCreateMutation = GT.Field({
  extensions: { 
    complexity: 120 
  },
  type: GT.NonNull(ApiTokenCreatePayload),
  description: "Generate a new API token for external service authentication. The token is only shown once and cannot be retrieved later.",
  args: {
    input: { 
      type: GT.NonNull(ApiTokenCreateInput) 
    }
  },
  resolve: async (
    _, 
    args, 
    { domainAccount }: GraphQLPublicContextAuth
  ) => {
    // Ensure user is authenticated
    if (!domainAccount) {
      return {
        errors: [{
          message: "Authentication required to create API tokens"
        }],
        apiToken: null
      }
    }
    
    // Create the API token
    const result = await createApiToken({
      accountId: domainAccount.id,
      name: args.input.name,
      scopes: args.input.scopes || ["read"],
      expiresIn: args.input.expiresIn || null
    })
    
    if (result instanceof Error) {
      return { 
        errors: [mapAndParseErrorForGqlResponse(result)],
        apiToken: null
      }
    }
    
    return {
      errors: [],
      apiToken: {
        id: result.id,
        name: result.name,
        token: result.token, // Only returned on creation
        scopes: result.scopes,
        expiresAt: result.expiresAt?.toISOString() || null,
        warning: result.warning
      }
    }
  }
})

export default ApiTokenCreateMutation