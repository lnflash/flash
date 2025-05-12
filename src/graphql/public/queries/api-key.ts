import { GT } from "@graphql/index"
import { ApiKeyService } from "@services/api-keys"
import { ApiKeyObjectType } from "../types/api-key"
import { ApiKeyError } from "@domain/api-keys/errors"
import { GraphQLPublicContext } from "../context"

export const apiKey = GT.Field({
  type: ApiKeyObjectType,
  description: "Get an API key by ID",
  args: {
    id: { type: GT.NonNullID },
  },
  resolve: async (_, { id }, context: GraphQLPublicContext) => {
    // Check if user is authenticated
    if (!context.domainAccount?.id) {
      throw new Error("You must be authenticated to view API keys")
    }

    try {
      // Get the API key
      const apiKey = await ApiKeyService.getById(id)

      // Check if user owns the API key
      if (apiKey.accountId !== context.domainAccount.id) {
        throw new Error("You do not have permission to view this API key")
      }

      // Transform dates to strings for GraphQL
      return {
        ...apiKey,
        createdAt: apiKey.createdAt.toISOString(),
        expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
        lastUsedAt: apiKey.lastUsedAt ? apiKey.lastUsedAt.toISOString() : null,
      }
    } catch (error) {
      if (error instanceof ApiKeyError) {
        throw new Error(error.message)
      }
      throw error
    }
  },
})

export const apiKeys = GT.Field({
  type: GT.NonNullList(ApiKeyObjectType),
  description: "Get all API keys for the authenticated account",
  resolve: async (_, __, context: GraphQLPublicContext) => {
    // Check if user is authenticated
    if (!context.domainAccount?.id) {
      throw new Error("You must be authenticated to view API keys")
    }

    try {
      // Get all API keys for the account
      const apiKeys = await ApiKeyService.listByAccountId(context.domainAccount.id)

      // Transform dates to strings for GraphQL
      return apiKeys.map((key) => ({
        ...key,
        createdAt: key.createdAt.toISOString(),
        expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
        lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
      }))
    } catch (error) {
      if (error instanceof ApiKeyError) {
        throw new Error(error.message)
      }
      throw error
    }
  },
})