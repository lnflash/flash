import { createHash } from "crypto"

import { createApiKey } from "@app/api-keys"
import {
  InvalidApiKeyNameError,
  InvalidApiKeyScopeError,
  MaxApiKeysPerAccountError,
  toApiKeyId,
  toApiKeyKeyId,
} from "@domain/api-keys"
import { UnknownRepositoryError } from "@domain/errors"
import { ApiKeysRepository } from "@services/mongoose/api-keys"

jest.mock("@config", () => ({
  getApiKeyConfig: jest.fn(() => ({ maxKeysPerAccount: 3 })),
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
}))

jest.mock("@services/mongoose/api-keys", () => ({
  ApiKeysRepository: jest.fn(),
}))

// verify-api-key (re-exported by @app/api-keys) pulls in the real mongoose
// schema tree via @services/mongoose — keep it out of this unit
jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(),
}))

const mockedApiKeysRepository = ApiKeysRepository as jest.MockedFunction<
  typeof ApiKeysRepository
>

const accountId = "account-id" as AccountId

describe("createApiKey", () => {
  let create: jest.Mock
  let findByAccountId: jest.Mock

  beforeEach(() => {
    create = jest.fn().mockImplementation(async (newKey: NewApiKey) => ({
      id: toApiKeyId("record-id"),
      keyId: newKey.keyId,
      accountId: newKey.accountId,
      name: newKey.name,
      hashedKey: newKey.hashedKey,
      scopes: newKey.scopes,
      status: "active" as ApiKeyStatus,
      ipConstraints: newKey.ipConstraints ?? [],
      metadata: newKey.metadata ?? {},
      lastUsedAt: null,
      createdAt: new Date(),
      expiresAt: newKey.expiresAt,
    }))
    findByAccountId = jest.fn().mockResolvedValue([])
    mockedApiKeysRepository.mockReturnValue({
      create,
      findByAccountId,
      findByKeyId: jest.fn(),
      updateLastUsedAt: jest.fn(),
      revoke: jest.fn(),
      revokeAll: jest.fn(),
    })
  })

  it("returns the raw key once and persists only its hash", async () => {
    const result = await createApiKey({ accountId, name: "BTCPay Server" })
    if (result instanceof Error) throw result

    expect(result.apiKey).toMatch(/^fk_[0-9a-f]{8}_[A-Za-z0-9_-]{64}$/)
    expect(result.warning).toContain("won't be shown again")

    const secret = result.apiKey.split("_").slice(2).join("_")
    const persisted = create.mock.calls[0][0]
    expect(persisted.hashedKey).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(persisted)).not.toContain(secret)
    expect(persisted.hashedKey).toBe(createHash("sha256").update(secret).digest("hex"))
  })

  it("defaults to the read:user scope", async () => {
    const result = await createApiKey({ accountId, name: "defaults" })
    if (result instanceof Error) throw result

    expect(result.scopes).toEqual(["read:user"])
  })

  it("computes expiresAt from expiresIn seconds", async () => {
    const before = Date.now()
    const result = await createApiKey({ accountId, name: "expiring", expiresIn: 3600 })
    if (result instanceof Error) throw result

    expect(result.expiresAt).not.toBeNull()
    const delta = (result.expiresAt as Date).getTime() - before
    expect(delta).toBeGreaterThanOrEqual(3600 * 1000 - 1000)
    expect(delta).toBeLessThanOrEqual(3600 * 1000 + 5000)
  })

  it("rejects invalid names without touching the repository", async () => {
    const result = await createApiKey({ accountId, name: "x" })

    expect(result).toBeInstanceOf(InvalidApiKeyNameError)
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects invalid scopes", async () => {
    const result = await createApiKey({
      accountId,
      name: "bad scopes",
      scopes: ["everything" as ApiKeyScope],
    })

    expect(result).toBeInstanceOf(InvalidApiKeyScopeError)
    expect(create).not.toHaveBeenCalled()
  })

  it("enforces the per-account key limit", async () => {
    const existing = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: toApiKeyId(`id-${i}`),
        keyId: toApiKeyKeyId(`0000000${i}`),
        accountId,
        name: `key-${i}` as ApiKeyName,
        hashedKey: "hash" as ApiKeySecretHash,
        scopes: ["read:user"] as ApiKeyScope[],
        status: "active" as ApiKeyStatus,
        ipConstraints: [],
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date(),
        expiresAt: null,
      }))
    findByAccountId.mockResolvedValue(existing(3))

    const result = await createApiKey({ accountId, name: "one too many" })

    expect(result).toBeInstanceOf(MaxApiKeysPerAccountError)
    expect(create).not.toHaveBeenCalled()
  })

  it("propagates repository errors from the limit check", async () => {
    findByAccountId.mockResolvedValue(new UnknownRepositoryError("boom"))

    const result = await createApiKey({ accountId, name: "repo down" })

    expect(result).toBeInstanceOf(UnknownRepositoryError)
    expect(create).not.toHaveBeenCalled()
  })
})
