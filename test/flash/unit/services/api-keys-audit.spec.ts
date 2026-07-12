import { toApiKeyKeyId } from "@domain/api-keys"
import {
  auditApiKeyCreated,
  auditApiKeyDenied,
  auditApiKeyRateLimited,
  auditApiKeyRevoked,
  auditApiKeyRotated,
} from "@services/api-keys-audit"
import { baseLogger } from "@services/logger"

jest.mock("@services/logger", () => ({
  baseLogger: { child: jest.fn(() => ({ info: jest.fn() })) },
}))

const childMock = baseLogger.child as jest.Mock
// The audit module creates its child logger once at load time
const auditLogger = childMock.mock.results[0].value as { info: jest.Mock }

const accountId = "account-id" as AccountId
const keyId = toApiKeyKeyId("a1b2c3d4")
const newKeyId = toApiKeyKeyId("e5f6a7b8")

describe("api keys audit", () => {
  beforeEach(() => {
    auditLogger.info.mockClear()
  })

  it("logs through a child logger bound to the api-keys-audit module", () => {
    expect(childMock).toHaveBeenCalledWith({ module: "api-keys-audit" })
  })

  it("audits key creation with an api_key.created event", () => {
    const expiresAt = new Date("2027-01-01T00:00:00.000Z")

    auditApiKeyCreated({
      accountId,
      keyId,
      scopes: ["read:wallet", "read:transactions"],
      expiresAt,
      rateLimitPerMinute: 300,
    })

    expect(auditLogger.info).toHaveBeenCalledWith(
      {
        event: "api_key.created",
        accountId,
        keyId,
        scopes: ["read:wallet", "read:transactions"],
        expiresAt,
        rateLimitPerMinute: 300,
      },
      "api key created",
    )
  })

  it("audits key revocation with an api_key.revoked event", () => {
    auditApiKeyRevoked({ accountId, keyId })

    expect(auditLogger.info).toHaveBeenCalledWith(
      { event: "api_key.revoked", accountId, keyId },
      "api key revoked",
    )
  })

  it("audits key rotation with both key ids", () => {
    auditApiKeyRotated({ accountId, oldKeyId: keyId, newKeyId })

    expect(auditLogger.info).toHaveBeenCalledWith(
      { event: "api_key.rotated", accountId, oldKeyId: keyId, newKeyId },
      "api key rotated",
    )
  })

  it("audits verification denials with reason and request ip", () => {
    auditApiKeyDenied({
      keyId,
      reason: "ApiKeySecretMismatchError",
      requestIp: "203.0.113.7",
    })

    expect(auditLogger.info).toHaveBeenCalledWith(
      {
        event: "api_key.denied",
        keyId,
        reason: "ApiKeySecretMismatchError",
        requestIp: "203.0.113.7",
      },
      "api key verification denied",
    )
  })

  it("audits denials of malformed keys without a keyId", () => {
    auditApiKeyDenied({ reason: "InvalidApiKeyFormatError" })

    expect(auditLogger.info).toHaveBeenCalledWith(
      {
        event: "api_key.denied",
        keyId: undefined,
        reason: "InvalidApiKeyFormatError",
        requestIp: undefined,
      },
      "api key verification denied",
    )
  })

  it("audits rate limiting with an api_key.rate_limited event", () => {
    auditApiKeyRateLimited({ keyId: "a1b2c3d4" })

    expect(auditLogger.info).toHaveBeenCalledWith(
      { event: "api_key.rate_limited", keyId: "a1b2c3d4" },
      "api key rate limited",
    )
  })

  it("never logs secret material — keyId only, in every audit payload", () => {
    auditApiKeyCreated({
      accountId,
      keyId,
      scopes: ["read:user"],
      expiresAt: null,
      rateLimitPerMinute: null,
    })
    auditApiKeyRevoked({ accountId, keyId })
    auditApiKeyRotated({ accountId, oldKeyId: keyId, newKeyId })
    auditApiKeyDenied({ keyId, reason: "ApiKeySecretMismatchError", requestIp: "::1" })
    auditApiKeyRateLimited({ keyId: "a1b2c3d4" })

    expect(auditLogger.info.mock.calls).toHaveLength(5)
    for (const [fields] of auditLogger.info.mock.calls) {
      for (const fieldName of Object.keys(fields)) {
        expect(fieldName).not.toMatch(/hash|secret|rawKey|fullKey|apiKey/i)
      }
      // No fk_-formatted raw key can appear anywhere in a payload
      expect(JSON.stringify(fields)).not.toMatch(/fk_[0-9a-f]{8}_/)
    }
  })
})
