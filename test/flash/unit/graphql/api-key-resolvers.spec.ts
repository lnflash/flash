import { createApiKey, updateApiKey, revokeApiKey, rotateApiKey } from "@graphql/public/mutations/api-key"
import { apiKey, apiKeys } from "@graphql/public/queries/api-key"
import { ApiKeyService } from "@services/api-keys"
import { ApiKeyStatus, ApiKeyType, Scope } from "@domain/api-keys"
import { GraphQLPublicContext } from "@graphql/public/context"

// Mock the API key service
jest.mock("@services/api-keys", () => ({
  ApiKeyService: {
    create: jest.fn(),
    getById: jest.fn(),
    listByAccountId: jest.fn(),
    update: jest.fn(),
    revoke: jest.fn(),
    initiateRotation: jest.fn(),
    completeRotation: jest.fn(),
  },
}))

describe("GraphQL API Key Resolvers", () => {
  let mockContext: GraphQLPublicContext
  let mockApiKey: any

  beforeEach(() => {
    jest.clearAllMocks()

    // Setup mock context
    mockContext = {
      domainAccount: {
        id: "account123",
      },
    }

    // Setup mock API key
    mockApiKey = {
      id: "api123",
      name: "Test API Key",
      accountId: "account123",
      type: ApiKeyType.Test,
      scopes: ["read:account", "read:wallet"] as Scope[],
      status: ApiKeyStatus.Active,
      createdAt: new Date(),
      expiresAt: null,
      lastUsedAt: null,
      tier: "DEFAULT",
      metadata: {},
      apiKey: "flash_test_12345abcdef",
    }

    // Setup mocks
    ;(ApiKeyService.create as jest.Mock).mockResolvedValue(mockApiKey)
    ;(ApiKeyService.getById as jest.Mock).mockResolvedValue(mockApiKey)
    ;(ApiKeyService.listByAccountId as jest.Mock).mockResolvedValue([mockApiKey])
    ;(ApiKeyService.update as jest.Mock).mockResolvedValue(mockApiKey)
    ;(ApiKeyService.revoke as jest.Mock).mockResolvedValue(true)
    ;(ApiKeyService.initiateRotation as jest.Mock).mockResolvedValue(mockApiKey)
  })

  describe("Mutations", () => {
    describe("createApiKey", () => {
      it("should create a new API key", async () => {
        const result = await createApiKey.resolve?.(
          null,
          {
            input: {
              name: "Test API Key",
              type: ApiKeyType.Test,
              scopes: ["read:account", "read:wallet"],
            },
          },
          mockContext,
          null as any
        )

        // Verify API key service was called
        expect(ApiKeyService.create).toHaveBeenCalledWith({
          name: "Test API Key",
          accountId: "account123",
          type: ApiKeyType.Test,
          scopes: ["read:account", "read:wallet"],
          expiresAt: undefined,
          tier: undefined,
          metadata: {},
        })

        // Verify result
        expect(result).toMatchObject({
          id: mockApiKey.id,
          name: mockApiKey.name,
          apiKey: mockApiKey.apiKey,
        })
      })

      it("should throw an error if user is not authenticated", async () => {
        await expect(
          createApiKey.resolve?.(
            null,
            {
              input: {
                name: "Test API Key",
                type: ApiKeyType.Test,
                scopes: ["read:account"],
              },
            },
            { domainAccount: null },
            null as any
          )
        ).rejects.toThrow("You must be authenticated to create an API key")
      })
    })

    describe("updateApiKey", () => {
      it("should update an API key", async () => {
        const result = await updateApiKey.resolve?.(
          null,
          {
            id: "api123",
            input: {
              name: "Updated API Key",
            },
          },
          mockContext,
          null as any
        )

        // Verify API key service was called
        expect(ApiKeyService.update).toHaveBeenCalledWith({
          id: "api123",
          name: "Updated API Key",
        })

        // Verify result
        expect(result).toMatchObject({
          id: mockApiKey.id,
          name: mockApiKey.name,
        })
      })

      it("should throw an error if user is not the owner", async () => {
        // Mock getById to return a key with different accountId
        ;(ApiKeyService.getById as jest.Mock).mockResolvedValue({
          ...mockApiKey,
          accountId: "different-account",
        })

        await expect(
          updateApiKey.resolve?.(
            null,
            {
              id: "api123",
              input: {
                name: "Updated API Key",
              },
            },
            mockContext,
            null as any
          )
        ).rejects.toThrow("You do not have permission to update this API key")
      })
    })

    describe("revokeApiKey", () => {
      it("should revoke an API key", async () => {
        const result = await revokeApiKey.resolve?.(
          null,
          { id: "api123" },
          mockContext,
          null as any
        )

        // Verify API key service was called
        expect(ApiKeyService.revoke).toHaveBeenCalledWith("api123")

        // Verify result
        expect(result).toBe(true)
      })
    })

    describe("rotateApiKey", () => {
      it("should initiate rotation for an API key", async () => {
        const result = await rotateApiKey.resolve?.(
          null,
          {
            id: "api123",
            input: {
              transitionPeriodDays: 14,
            },
          },
          mockContext,
          null as any
        )

        // Verify API key service was called
        expect(ApiKeyService.initiateRotation).toHaveBeenCalledWith({
          id: "api123",
          transitionPeriodDays: 14,
        })

        // Verify result
        expect(result).toMatchObject({
          id: mockApiKey.id,
          name: mockApiKey.name,
          apiKey: mockApiKey.apiKey,
        })
      })
    })
  })

  describe("Queries", () => {
    describe("apiKey", () => {
      it("should get an API key by ID", async () => {
        const result = await apiKey.resolve?.(
          null,
          { id: "api123" },
          mockContext,
          null as any
        )

        // Verify API key service was called
        expect(ApiKeyService.getById).toHaveBeenCalledWith("api123")

        // Verify result
        expect(result).toMatchObject({
          id: mockApiKey.id,
          name: mockApiKey.name,
        })
      })

      it("should throw an error if user is not the owner", async () => {
        // Mock getById to return a key with different accountId
        ;(ApiKeyService.getById as jest.Mock).mockResolvedValue({
          ...mockApiKey,
          accountId: "different-account",
        })

        await expect(
          apiKey.resolve?.(null, { id: "api123" }, mockContext, null as any)
        ).rejects.toThrow("You do not have permission to view this API key")
      })
    })

    describe("apiKeys", () => {
      it("should list all API keys for the account", async () => {
        const result = await apiKeys.resolve?.(null, {}, mockContext, null as any)

        // Verify API key service was called
        expect(ApiKeyService.listByAccountId).toHaveBeenCalledWith("account123")

        // Verify result
        expect(result).toBeInstanceOf(Array)
        expect(result.length).toBe(1)
        expect(result[0]).toMatchObject({
          id: mockApiKey.id,
          name: mockApiKey.name,
        })
      })

      it("should throw an error if user is not authenticated", async () => {
        await expect(
          apiKeys.resolve?.(null, {}, { domainAccount: null }, null as any)
        ).rejects.toThrow("You must be authenticated to view API keys")
      })
    })
  })
})