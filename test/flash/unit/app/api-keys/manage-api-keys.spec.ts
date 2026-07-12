import { listApiKeys, revokeApiKey, rotateApiKey } from "@app/api-keys"
import { ApiKeyExpiredError, generateApiKey, toApiKeyId } from "@domain/api-keys"
import { CouldNotFindError, UnknownRepositoryError } from "@domain/errors"
import { ApiKeysRepository } from "@services/mongoose/api-keys"

jest.mock("@config", () => ({
  getApiKeyConfig: jest.fn(() => ({ maxKeysPerAccount: 10 })),
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
}))

jest.mock("@services/mongoose/api-keys", () => ({
  ApiKeysRepository: jest.fn(),
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(),
}))

const mockedApiKeysRepository = ApiKeysRepository as jest.MockedFunction<
  typeof ApiKeysRepository
>

const accountId = "account-id" as AccountId
const oldGenerated = generateApiKey()

const oldKey: ApiKey = {
  id: toApiKeyId("old-id"),
  keyId: oldGenerated.keyId,
  accountId,
  name: "BTCPay Server" as ApiKeyName,
  hashedKey: oldGenerated.hashedSecret,
  scopes: ["read:wallet", "write:wallet"] as ApiKeyScope[],
  status: "active" as ApiKeyStatus,
  ipConstraints: ["10.0.0.0/8"],
  metadata: { env: "prod" },
  lastUsedAt: null,
  createdAt: new Date("2026-01-01"),
  expiresAt: new Date("2099-01-01"),
}

describe("api key management", () => {
  let repo: {
    create: jest.Mock
    findByKeyId: jest.Mock
    findByAccountId: jest.Mock
    listByAccountId: jest.Mock
    findActiveByIdForAccount: jest.Mock
    updateLastUsedAt: jest.Mock
    revoke: jest.Mock
    revokeAll: jest.Mock
  }

  beforeEach(() => {
    repo = {
      create: jest.fn().mockImplementation(async (k: NewApiKey) => ({
        ...oldKey,
        id: toApiKeyId("new-id"),
        keyId: k.keyId,
        hashedKey: k.hashedKey,
        name: k.name,
        scopes: k.scopes,
        ipConstraints: k.ipConstraints ?? [],
        metadata: k.metadata ?? {},
        expiresAt: k.expiresAt,
      })),
      findByKeyId: jest.fn(),
      findByAccountId: jest.fn(),
      listByAccountId: jest.fn().mockResolvedValue([oldKey]),
      findActiveByIdForAccount: jest.fn().mockResolvedValue(oldKey),
      updateLastUsedAt: jest.fn(),
      revoke: jest.fn().mockResolvedValue({ ...oldKey, status: "revoked" }),
      revokeAll: jest.fn(),
    }
    mockedApiKeysRepository.mockReturnValue(repo)
  })

  describe("listApiKeys", () => {
    it("lists every key for the account", async () => {
      const result = await listApiKeys({ accountId })
      if (result instanceof Error) throw result

      expect(repo.listByAccountId).toHaveBeenCalledWith(accountId)
      expect(result).toEqual([oldKey])
    })
  })

  describe("revokeApiKey", () => {
    it("revokes account-scoped", async () => {
      const result = await revokeApiKey({ id: oldKey.id, accountId })
      if (result instanceof Error) throw result

      expect(repo.revoke).toHaveBeenCalledWith({ id: oldKey.id, accountId })
      expect(result.status).toBe("revoked")
    })

    it("propagates not-found (wrong account or unknown id)", async () => {
      repo.revoke.mockResolvedValue(new CouldNotFindError("API key not found"))

      expect(await revokeApiKey({ id: oldKey.id, accountId })).toBeInstanceOf(
        CouldNotFindError,
      )
    })
  })

  describe("rotateApiKey", () => {
    it("creates the replacement before revoking the old key", async () => {
      const result = await rotateApiKey({ id: oldKey.id, accountId })
      if (result instanceof Error) throw result

      expect(result.apiKey).toMatch(/^fk_[0-9a-f]{8}_[A-Za-z0-9_-]{64}$/)
      expect(result.keyId).not.toBe(oldKey.keyId)
      expect(result.revokedKeyId).toBe(oldKey.keyId)
      expect(result.name).toBe(oldKey.name)
      expect(result.scopes).toEqual(oldKey.scopes)
      expect(result.expiresAt).toEqual(oldKey.expiresAt)

      const created = repo.create.mock.calls[0][0]
      expect(created.ipConstraints).toEqual(oldKey.ipConstraints)
      expect(created.metadata).toEqual(oldKey.metadata)
      expect(repo.revoke).toHaveBeenCalledWith({ id: oldKey.id, accountId })

      const createOrder = repo.create.mock.invocationCallOrder[0]
      const revokeOrder = repo.revoke.mock.invocationCallOrder[0]
      expect(createOrder).toBeLessThan(revokeOrder)
    })

    it("rejects rotating an expired key", async () => {
      repo.findActiveByIdForAccount.mockResolvedValue({
        ...oldKey,
        expiresAt: new Date(Date.now() - 1000),
      })

      const result = await rotateApiKey({ id: oldKey.id, accountId })

      expect(result).toBeInstanceOf(ApiKeyExpiredError)
      expect(repo.create).not.toHaveBeenCalled()
    })

    it("leaves the old key untouched when creating the replacement fails", async () => {
      repo.create.mockResolvedValue(new UnknownRepositoryError("boom"))

      const result = await rotateApiKey({ id: oldKey.id, accountId })

      expect(result).toBeInstanceOf(UnknownRepositoryError)
      expect(repo.revoke).not.toHaveBeenCalled()
    })

    it("compensates by revoking the replacement when revoking the old key fails", async () => {
      repo.revoke
        .mockResolvedValueOnce(new UnknownRepositoryError("revoke failed"))
        .mockResolvedValueOnce({ ...oldKey, id: toApiKeyId("new-id"), status: "revoked" })

      const result = await rotateApiKey({ id: oldKey.id, accountId })

      expect(result).toBeInstanceOf(UnknownRepositoryError)
      expect(repo.revoke).toHaveBeenNthCalledWith(1, { id: oldKey.id, accountId })
      expect(repo.revoke).toHaveBeenNthCalledWith(2, {
        id: toApiKeyId("new-id"),
        accountId,
      })
    })

    it("propagates not-found for a foreign or missing key", async () => {
      repo.findActiveByIdForAccount.mockResolvedValue(
        new CouldNotFindError("API key not found"),
      )

      expect(await rotateApiKey({ id: oldKey.id, accountId })).toBeInstanceOf(
        CouldNotFindError,
      )
      expect(repo.create).not.toHaveBeenCalled()
    })
  })
})
