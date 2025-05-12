import { ApiKeyService } from "@services/api-keys"
import {
  ApiKeyStatus,
  ApiKeyType,
  ApiKeyWithSecrets,
  Scope,
  ALL_SCOPES,
} from "@domain/api-keys"
import {
  ApiKeyNotFoundError,
  ApiKeyInvalidError,
  ApiKeyRevokedError,
  InvalidAccountIdError,
} from "@domain/api-keys/errors"
import { ApiKey } from "@services/mongoose/api-keys"

// Mock the mongoose model
jest.mock("@services/mongoose/api-keys", () => ({
  ApiKey: {
    create: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}))

describe("ApiKeyService", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("create", () => {
    const createParams = {
      name: "Test API Key",
      accountId: "account123",
      type: ApiKeyType.Test,
      scopes: ["read:account"] as Scope[],
    }

    const mockApiKeyRecord = {
      id: "api123",
      name: "Test API Key",
      accountId: "account123",
      type: ApiKeyType.Test,
      status: ApiKeyStatus.Active,
      scopes: ["read:account"],
      createdAt: new Date(),
      expiresAt: null,
      lastUsedAt: null,
      tier: "DEFAULT",
      metadata: {},
    }

    it("should create a new API key", async () => {
      // Mock the mongoose create method
      (ApiKey.create as jest.Mock).mockResolvedValue(mockApiKeyRecord)

      const result = await ApiKeyService.create(createParams)

      // Verify API key was created
      expect(ApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: createParams.name,
          accountId: createParams.accountId,
          type: createParams.type,
          scopes: createParams.scopes,
          status: ApiKeyStatus.Active,
        })
      )

      // Verify correct data is returned
      expect(result).toMatchObject({
        id: mockApiKeyRecord.id,
        name: mockApiKeyRecord.name,
        accountId: mockApiKeyRecord.accountId,
        type: mockApiKeyRecord.type,
        status: mockApiKeyRecord.status,
        scopes: mockApiKeyRecord.scopes,
      })

      // Verify API key is returned
      expect(result).toHaveProperty("apiKey")
      expect(result.apiKey).toMatch(/^flash_test_/)
    })

    it("should throw an error if name is invalid", async () => {
      await expect(
        ApiKeyService.create({
          ...createParams,
          name: "ab", // Too short
        })
      ).rejects.toThrow(expect.any(Error))
    })

    it("should throw an error if accountId is missing", async () => {
      await expect(
        ApiKeyService.create({
          ...createParams,
          accountId: "", // Empty
        })
      ).rejects.toThrow(InvalidAccountIdError)
    })
  })

  describe("getById", () => {
    const mockApiKeyRecord = {
      id: "api123",
      name: "Test API Key",
      accountId: "account123",
      hashedKey: "hashedKey123",
      type: ApiKeyType.Test,
      status: ApiKeyStatus.Active,
      scopes: ["read:account"],
      createdAt: new Date(),
      expiresAt: null,
      lastUsedAt: null,
      tier: "DEFAULT",
      metadata: {},
    }

    it("should return an API key by ID", async () => {
      // Mock the mongoose findOne method
      (ApiKey.findOne as jest.Mock).mockResolvedValue(mockApiKeyRecord)

      const result = await ApiKeyService.getById(mockApiKeyRecord.id)

      // Verify correct query was made
      expect(ApiKey.findOne).toHaveBeenCalledWith({ id: mockApiKeyRecord.id })

      // Verify correct data is returned
      expect(result).toMatchObject({
        id: mockApiKeyRecord.id,
        name: mockApiKeyRecord.name,
        accountId: mockApiKeyRecord.accountId,
        type: mockApiKeyRecord.type,
        status: mockApiKeyRecord.status,
        scopes: mockApiKeyRecord.scopes,
        hashedKey: mockApiKeyRecord.hashedKey,
      })
    })

    it("should throw an error if API key is not found", async () => {
      // Mock the mongoose findOne method to return null
      (ApiKey.findOne as jest.Mock).mockResolvedValue(null)

      await expect(ApiKeyService.getById("api123")).rejects.toThrow(ApiKeyNotFoundError)
    })
  })

  describe("verifyKey", () => {
    let mockApiKey: ApiKeyWithSecrets

    beforeEach(() => {
      // Create a real API key for testing
      mockApiKey = {
        id: "api123",
        name: "Test API Key",
        accountId: "account123",
        type: ApiKeyType.Test,
        status: ApiKeyStatus.Active,
        scopes: ALL_SCOPES as Scope[],
        createdAt: new Date(),
        expiresAt: null,
        lastUsedAt: null,
        tier: "DEFAULT",
        metadata: {},
        apiKey: "flash_test_12345abcdef",
        privateKey: "mock-private-key",
      }

      // Mock the mongoose find method
      (ApiKey.find as jest.Mock).mockResolvedValue([
        {
          ...mockApiKey,
          hashedKey: "hashedKey123",
        },
      ])
    })

    it("should verify a valid API key", async () => {
      // This test would need more work in a real implementation
      // since we can't easily test the timing-safe comparison
      await expect(ApiKeyService.verifyKey(mockApiKey.apiKey)).resolves.toBeDefined()

      // Verify API key usage is updated
      expect(ApiKey.updateOne).toHaveBeenCalledWith(
        { id: mockApiKey.id },
        { $set: { lastUsedAt: expect.any(Date) } }
      )
    })

    it("should throw an error for an invalid API key format", async () => {
      await expect(ApiKeyService.verifyKey("invalid-key")).rejects.toThrow(ApiKeyInvalidError)
    })

    it("should throw an error if API key is revoked", async () => {
      // Change the API key status to revoked
      (ApiKey.find as jest.Mock).mockResolvedValue([
        {
          ...mockApiKey,
          status: ApiKeyStatus.Revoked,
        },
      ])

      await expect(ApiKeyService.verifyKey(mockApiKey.apiKey)).rejects.toThrow(ApiKeyRevokedError)
    })
  })

  describe("revoke", () => {
    it("should revoke an API key", async () => {
      // Mock the mongoose updateOne method
      (ApiKey.updateOne as jest.Mock).mockResolvedValue({ matchedCount: 1 })

      const result = await ApiKeyService.revoke("api123")

      // Verify correct query was made
      expect(ApiKey.updateOne).toHaveBeenCalledWith(
        { id: "api123" },
        { $set: { status: ApiKeyStatus.Revoked } }
      )

      // Verify result
      expect(result).toBe(true)
    })

    it("should throw an error if API key is not found", async () => {
      // Mock the mongoose updateOne method to return no matches
      (ApiKey.updateOne as jest.Mock).mockResolvedValue({ matchedCount: 0 })

      await expect(ApiKeyService.revoke("api123")).rejects.toThrow(ApiKeyNotFoundError)
    })
  })

  // Additional tests for other methods would be added here
})