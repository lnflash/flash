import { Request, Response } from "express"

import { verifyApiKey } from "@app/api-keys"
import { InvalidApiKeyFormatError, toApiKeyId, toApiKeyKeyId } from "@domain/api-keys"
import { apiKeyCheckHandler } from "@servers/authorization/api-key-check"

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
}))

jest.mock("@app/api-keys", () => ({
  verifyApiKey: jest.fn(),
}))

const mockedVerifyApiKey = verifyApiKey as jest.MockedFunction<typeof verifyApiKey>

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
    lastUsedAt: null,
    createdAt: new Date(),
    expiresAt: null,
    ...overrides,
  },
})

describe("apiKeyCheckHandler", () => {
  beforeEach(() => {
    mockedVerifyApiKey.mockReset()
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
    })
  })

  it("sends empty expires_at even for expiring keys (no kratos session-extend)", async () => {
    const expiresAt = new Date("2027-01-01T00:00:00.000Z")
    mockedVerifyApiKey.mockResolvedValue(verifiedApiKey({ expiresAt }))
    const res = makeRes()

    await apiKeyCheckHandler(makeReq({ "x-api-key": "fk_valid_key" }), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ expires_at: "" }))
  })
})
