import { GT } from "@graphql/index"
import { ApiKeyService } from "@services/api-keys"
import {
  ApiKeyObjectType,
  ApiKeyWithSecretType,
  CreateApiKeyInput,
  UpdateApiKeyInput,
  RotateApiKeyInput,
} from "../types/api-key"
import { GraphQLPublicContext } from "../context"
import { ApiKeyError } from "@domain/api-keys/errors"
import { ApiKeyStatus, ApiKeyType as ApiKeyTypeEnum, Scope } from "@domain/api-keys"

export const createApiKey = GT.Field({
  type: ApiKeyWithSecretType,
  description: "Create a new API key",
  args: {
    input: { type: GT.NonNull(CreateApiKeyInput) },
  },
  resolve: async (_, { input }, context: GraphQLPublicContext) => {
    // Check if user is authenticated
    if (!context.domainAccount?.id) {
      throw new Error("You must be authenticated to create an API key")
    }

    try {
      const { name, type, scopes, expiresAt, tier, metadata: metadataString } = input

      // Parse metadata JSON if provided
      let metadata: Record<string, unknown> = {}
      if (metadataString) {
        try {
          metadata = JSON.parse(metadataString)
        } catch (error) {
          throw new Error("Invalid metadata JSON")
        }
      }

      // Create expiration date if provided
      let expirationDate: Date | undefined
      if (expiresAt) {
        expirationDate = new Date(expiresAt)
        if (isNaN(expirationDate.getTime())) {
          throw new Error("Invalid expiration date")
        }
      }

      // Create the API key
      const apiKey = await ApiKeyService.create({
        name,
        accountId: context.domainAccount.id,
        type: type as ApiKeyTypeEnum,
        scopes: scopes as Scope[],
        expiresAt: expirationDate,
        tier,
        metadata,
      })

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

export const updateApiKey = GT.Field({
  type: ApiKeyObjectType,
  description: "Update an existing API key",
  args: {
    id: { type: GT.NonNullID },
    input: { type: GT.NonNull(UpdateApiKeyInput) },
  },
  resolve: async (_, { id, input }, context: GraphQLPublicContext) => {
    // Check if user is authenticated
    if (!context.domainAccount?.id) {
      throw new Error("You must be authenticated to update an API key")
    }

    try {
      const { name, scopes, expiresAt, tier, metadata: metadataString } = input

      // Parse metadata JSON if provided
      let metadata: Record<string, unknown> | undefined
      if (metadataString) {
        try {
          metadata = JSON.parse(metadataString)
        } catch (error) {
          throw new Error("Invalid metadata JSON")
        }
      }

      // Parse expiration date if provided
      let expirationDate: Date | null | undefined
      if (expiresAt === null) {
        expirationDate = null
      } else if (expiresAt) {
        expirationDate = new Date(expiresAt)
        if (isNaN(expirationDate.getTime())) {
          throw new Error("Invalid expiration date")
        }
      }

      // Get the API key to check ownership
      const existingKey = await ApiKeyService.getById(id)
      if (existingKey.accountId !== context.domainAccount.id) {
        throw new Error("You do not have permission to update this API key")
      }

      // Update the API key
      const updatedKey = await ApiKeyService.update({
        id,
        name,
        scopes: scopes as Scope[] | undefined,
        expiresAt: expirationDate,
        tier,
        metadata,
      })

      // Transform dates to strings for GraphQL
      return {
        ...updatedKey,
        createdAt: updatedKey.createdAt.toISOString(),
        expiresAt: updatedKey.expiresAt ? updatedKey.expiresAt.toISOString() : null,
        lastUsedAt: updatedKey.lastUsedAt ? updatedKey.lastUsedAt.toISOString() : null,
      }
    } catch (error) {
      if (error instanceof ApiKeyError) {
        throw new Error(error.message)
      }
      throw error
    }
  },
})

export const revokeApiKey = GT.Field({
  type: GT.Boolean,
  description: "Revoke an API key",
  args: {
    id: { type: GT.NonNullID },
  },
  resolve: async (_, { id }, context: GraphQLPublicContext) => {
    // Check if user is authenticated
    if (!context.domainAccount?.id) {
      throw new Error("You must be authenticated to revoke an API key")
    }

    try {
      // Get the API key to check ownership
      const existingKey = await ApiKeyService.getById(id)
      if (existingKey.accountId !== context.domainAccount.id) {
        throw new Error("You do not have permission to revoke this API key")
      }

      // Revoke the API key
      return await ApiKeyService.revoke(id)
    } catch (error) {
      if (error instanceof ApiKeyError) {
        throw new Error(error.message)
      }
      throw error
    }
  },
})

export const rotateApiKey = GT.Field({
  type: ApiKeyWithSecretType,
  description: "Rotate an API key (creates a new key and schedules the old one for revocation)",
  args: {
    id: { type: GT.NonNullID },
    input: { type: RotateApiKeyInput },
  },
  resolve: async (_, { id, input }, context: GraphQLPublicContext) => {
    // Check if user is authenticated
    if (!context.domainAccount?.id) {
      throw new Error("You must be authenticated to rotate an API key")
    }

    try {
      // Get the API key to check ownership
      const existingKey = await ApiKeyService.getById(id)
      if (existingKey.accountId !== context.domainAccount.id) {
        throw new Error("You do not have permission to rotate this API key")
      }

      // Start the key rotation
      const transitionPeriodDays = input?.transitionPeriodDays
      const newKey = await ApiKeyService.initiateRotation({
        id,
        transitionPeriodDays,
      })

      // Transform dates to strings for GraphQL
      return {
        ...newKey,
        createdAt: newKey.createdAt.toISOString(),
        expiresAt: newKey.expiresAt ? newKey.expiresAt.toISOString() : null,
        lastUsedAt: newKey.lastUsedAt ? newKey.lastUsedAt.toISOString() : null,
      }
    } catch (error) {
      if (error instanceof ApiKeyError) {
        throw new Error(error.message)
      }
      throw error
    }
  },
})

export const completeApiKeyRotation = GT.Field({
  type: GT.Boolean,
  description: "Complete an API key rotation (revokes the old key)",
  args: {
    id: { type: GT.NonNullID },
  },
  resolve: async (_, { id }, context: GraphQLPublicContext) => {
    // Check if user is authenticated
    if (!context.domainAccount?.id) {
      throw new Error("You must be authenticated to complete an API key rotation")
    }

    try {
      // Get the API key to check ownership
      const existingKey = await ApiKeyService.getById(id)
      if (existingKey.accountId !== context.domainAccount.id) {
        throw new Error("You do not have permission to complete this API key rotation")
      }

      // Check if the key is in rotation
      if (existingKey.status !== ApiKeyStatus.Rotating) {
        throw new Error("This API key is not in rotation")
      }

      // Complete the rotation
      return await ApiKeyService.completeRotation(id)
    } catch (error) {
      if (error instanceof ApiKeyError) {
        throw new Error(error.message)
      }
      throw error
    }
  },
})