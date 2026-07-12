import { Request, Response } from "express"

import { verifyApiKey } from "@app/api-keys"
import {
  ApiKeySecretMismatchError,
  InvalidApiKeyFormatError,
  toApiKeyId,
  toApiKeyKeyId,
} from "@domain/api-keys"
import { apiKeyCheckHandler } from "@servers/authorization/api-key-check"
import { auditApiKeyDenied } from "@services/api-keys-audit"
import { incApiKeyVerification } from "@services/api-keys-metrics"

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
}))

jest.mock("@app/api-keys", () => ({
  verifyApiKey: jest.fn(),
}))

jest.mock("@config", () => ({
  getApiKeyConfig: jest.fn(() => ({
    maxKeysPerAccount: 10,
    defaultRequestsPerMinute: 120,
  })),
}))

jest.mock("@services/api-keys-metrics", () => ({
  incApiKeyVerification: jest.fn(),
}))

jest.mock("@services/api-keys-audit", () => ({
  auditApiKeyDenied: jest.fn(),
}))

const mockedVerifyApiKey = verifyApiKey as jest.MockedFunction<typeof verifyApiKey>
const mockedIncVerification = incApiKeyVerification as jest.MockedFunction<
  typeof incApiKeyVerification
>
const mockedAuditDenied = auditApiKeyDenied as jest.MockedFunction<
  typeof auditApiKeyDenied
>

const makeRes = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  }
  res.status.mockReturnValue(res)
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock }
}

const makeReq = (headers: Record<string, string> = {}) =>
  ({ headers }) as unknown as Request

const verifiedApiKey = (overrides: Partial<ApiKey> = {}): VerifiedApiKey => ({
  kratosUserId: "kratos-user-id" as UserId,
  apiKey: {
    id: toApiKeyId("record-id"),
    keyId: toApiKeyKeyId("a1b2c3d4"),
    accountId: "account-id" as AccountId,
    name: "BTCPay Server" as ApiKeyName,
    hashedKey: "hash" as ApiKeySecretHash,
    scopes: ["read:wallet", "read:transactions"] as ApiKeyScope[],
    status: "active" as ApiKeyStatus,
    ipConstraints: [],
    metadata: {},
    rateLimitPerMinute: null,
    lastUsedAt: null,
    createdAt: new Date(),
    expiresAt: null,
    ...overrides,
  },
})

describe("apiKeyCheckHandler", () => {
  beforeEach(() => {
    mockedVerifyApiKey.mockReset()
    mockedIncVerification.mockReset()
    mockedAuditDenied.mockReset()
  })

  it("401s when the X-API-KEY header is missing", async () => {
    const res = makeRes()

    await apiKeyCheckHandler(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(mockedVerifyApiKey).not.toHaveBeenCalled()
  })

  it("401s with a generic body when verification fails", async () => {
    mockedVerifyApiKey.mockResolvedValue(new InvalidApiKeyFormatError())
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": "fk_bad" }), res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: "invalid_api_key" })
  })

  it("forwards the X-Real-Ip header to verifyApiKey as requestIp", async () => {
    mockedVerifyApiKey.mockResolvedValue(verifiedApiKey())
    const res = makeRes()

    await apiKeyCheckHandler(
      makeReq({ "x-api-key": "fk_valid_key", "x-real-ip": "203.0.113.7" }),
      res,
    )

    expect(mockedVerifyApiKey).toHaveBeenCalledWith({
      rawKey: "fk_valid_key",
      requestIp: "203.0.113.7",
    })
  })

  it("passes an undefined requestIp when X-Real-Ip is absent", async () => {
    mockedVerifyApiKey.mockResolvedValue(verifiedApiKey())
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": "fk_valid_key" }), res)

    expect(mockedVerifyApiKey).toHaveBeenCalledWith({
      rawKey: "fk_valid_key",
      requestIp: undefined,
    })
  })

  it("returns a kratos-whoami-shaped body on success", async () => {
    mockedVerifyApiKey.mockResolvedValue(verifiedApiKey())
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": "fk_valid_key" }), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      identity: { id: "kratos-user-id" },
      id: "apikey:a1b2c3d4",
      expires_at: "",
      scope: "read:wallet read:transactions",
      rate_limit: 120,
    })
  })

  it("surfaces a per-key rate limit as the rate_limit claim", async () => {
    mockedVerifyApiKey.mockResolvedValue(verifiedApiKey({ rateLimitPerMinute: 250 }))
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": "fk_valid_key" }), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ rate_limit: 250 }))
  })

  it("falls back to the config default rate_limit for keys without one", async () => {
    mockedVerifyApiKey.mockResolvedValue(verifiedApiKey({ rateLimitPerMinute: null }))
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": "fk_valid_key" }), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ rate_limit: 120 }))
  })

  it("sends empty expires_at even for expiring keys (no kratos session-extend)", async () => {
    const expiresAt = new Date("2027-01-01T00:00:00.000Z")
    mockedVerifyApiKey.mockResolvedValue(verifiedApiKey({ expiresAt }))
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": "fk_valid_key" }), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ expires_at: "" }))
  })

  // fk_{8 hex}_{64 base64url} — parseable, so denials can audit the keyId
  const WELL_FORMED_KEY = `fk_a1b2c3d4_${"x".repeat(64)}`

  it("increments the denied verification counter and audits the denial", async () => {
    mockedVerifyApiKey.mockResolvedValue(new ApiKeySecretMismatchError("a1b2c3d4"))
    const res = makeRes()

    await apiKeyCheckHandler(
      makeReq({ "x-api-key": WELL_FORMED_KEY, "x-real-ip": "203.0.113.7" }),
      res,
    )

    expect(mockedIncVerification).toHaveBeenCalledWith(
      "denied",
      "ApiKeySecretMismatchError",
    )
    expect(mockedAuditDenied).toHaveBeenCalledWith({
      keyId: "a1b2c3d4",
      reason: "ApiKeySecretMismatchError",
      requestIp: "203.0.113.7",
    })
  })

  it("audits denials of malformed keys without a keyId", async () => {
    mockedVerifyApiKey.mockResolvedValue(new InvalidApiKeyFormatError())
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": "fk_bad" }), res)

    expect(mockedIncVerification).toHaveBeenCalledWith(
      "denied",
      "InvalidApiKeyFormatError",
    )
    expect(mockedAuditDenied).toHaveBeenCalledWith({
      keyId: undefined,
      reason: "InvalidApiKeyFormatError",
      requestIp: undefined,
    })
  })

  it("increments the success verification counter and does not audit", async () => {
    mockedVerifyApiKey.mockResolvedValue(verifiedApiKey())
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": WELL_FORMED_KEY }), res)

    expect(mockedIncVerification).toHaveBeenCalledTimes(1)
    expect(mockedIncVerification).toHaveBeenCalledWith("success")
    expect(mockedAuditDenied).not.toHaveBeenCalled()
  })
})
