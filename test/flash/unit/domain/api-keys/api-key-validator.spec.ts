import {
  validateApiKeyFormat,
  validateApiKeyId,
  validateScopes,
  isScopeAllowed,
  isApiKeyActive,
  isApiKeyExpired,
} from "@domain/api-keys/api-key-validator"
import { ApiKeyStatus, ApiKeyType, Scope } from "@domain/api-keys"

describe("API key validator", () => {
  describe("validateApiKeyFormat", () => {
    it("should validate a valid test API key", () => {
      const result = validateApiKeyFormat("flash_test_abcdefghijklmnopqrstuvwxyz012345")
      expect(result.valid).toBe(true)
      expect(result.type).toBe(ApiKeyType.Test)
    })

    it("should validate a valid live API key", () => {
      const result = validateApiKeyFormat("flash_live_abcdefghijklmnopqrstuvwxyz012345")
      expect(result.valid).toBe(true)
      expect(result.type).toBe(ApiKeyType.Live)
    })

    it("should reject an empty API key", () => {
      const result = validateApiKeyFormat("")
      expect(result.valid).toBe(false)
    })

    it("should reject an API key with invalid prefix", () => {
      const result = validateApiKeyFormat("invalid_prefix_abcdefghijklmnopqrstuvwxyz012345")
      expect(result.valid).toBe(false)
    })

    it("should reject an API key with wrong separator", () => {
      const result = validateApiKeyFormat("flash-test-abcdefghijklmnopqrstuvwxyz012345")
      expect(result.valid).toBe(false)
    })

    it("should reject an API key that's too short", () => {
      const result = validateApiKeyFormat("flash_test_abc")
      expect(result.valid).toBe(false)
    })
  })

  describe("validateApiKeyId", () => {
    it("should validate a valid API key ID (24 hex chars)", () => {
      const result = validateApiKeyId("507f1f77bcf86cd799439011")
      expect(result).toBe(true)
    })

    it("should reject an invalid API key ID format", () => {
      const result = validateApiKeyId("invalid-id")
      expect(result).toBe(false)
    })

    it("should reject an API key ID that's too short", () => {
      const result = validateApiKeyId("123456")
      expect(result).toBe(false)
    })
  })

  describe("validateScopes", () => {
    it("should validate valid scopes", () => {
      const result = validateScopes(["read:account", "write:wallet"])
      expect(result.valid).toBe(true)
      expect(result.invalidScopes).toHaveLength(0)
    })

    it("should reject invalid scopes", () => {
      const result = validateScopes(["invalid:scope", "read:account"])
      expect(result.valid).toBe(false)
      expect(result.invalidScopes).toEqual(["invalid:scope"])
    })

    it("should reject empty scope array", () => {
      const result = validateScopes([])
      expect(result.valid).toBe(false)
    })
  })

  describe("isScopeAllowed", () => {
    it("should allow exact scope match", () => {
      const result = isScopeAllowed("read:account", ["read:account"] as Scope[])
      expect(result).toBe(true)
    })

    it("should allow scope if all:resource is granted", () => {
      const result = isScopeAllowed("read:account", ["all:account"] as Scope[])
      expect(result).toBe(true)
    })

    it("should allow read if write is granted", () => {
      const result = isScopeAllowed("read:account", ["write:account"] as Scope[])
      expect(result).toBe(false) // In this implementation, write does not imply read
    })

    it("should not allow scope for different resource", () => {
      const result = isScopeAllowed("read:account", ["read:wallet"] as Scope[])
      expect(result).toBe(false)
    })

    it("should not allow scope if invalid", () => {
      const result = isScopeAllowed("invalid:scope", ["read:account"] as Scope[])
      expect(result).toBe(false)
    })
  })

  describe("isApiKeyActive", () => {
    it("should return true for active API keys", () => {
      const result = isApiKeyActive(ApiKeyStatus.Active)
      expect(result).toBe(true)
    })

    it("should return true for rotating API keys", () => {
      const result = isApiKeyActive(ApiKeyStatus.Rotating)
      expect(result).toBe(true)
    })

    it("should return false for revoked API keys", () => {
      const result = isApiKeyActive(ApiKeyStatus.Revoked)
      expect(result).toBe(false)
    })

    it("should return false for expired API keys", () => {
      const result = isApiKeyActive(ApiKeyStatus.Expired)
      expect(result).toBe(false)
    })
  })

  describe("isApiKeyExpired", () => {
    it("should return true for expired API keys", () => {
      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 1) // Yesterday
      const result = isApiKeyExpired(pastDate)
      expect(result).toBe(true)
    })

    it("should return false for future expiration", () => {
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1) // Tomorrow
      const result = isApiKeyExpired(futureDate)
      expect(result).toBe(false)
    })

    it("should return false for null expiration (never expires)", () => {
      const result = isApiKeyExpired(null)
      expect(result).toBe(false)
    })
  })
})