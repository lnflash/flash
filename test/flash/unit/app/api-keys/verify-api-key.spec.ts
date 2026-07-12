import { verifyApiKey } from "@app/api-keys"
import {
  ApiKeyExpiredError,
  ApiKeyIpNotAllowedError,
  ApiKeySecretMismatchError,
  InvalidApiKeyFormatError,
  generateApiKey,
  toApiKeyId,
} from "@domain/api-keys"
import { CouldNotFindError, UnknownRepositoryError } from "@domain/errors"
import { AccountsRepository } from "@services/mongoose"
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
const mockedAccountsRepository = AccountsRepository as jest.MockedFunction<
  typeof AccountsRepository
>

const kratosUserId = "kratos-user-id" as UserId
const accountId = "account-id" as AccountId

const generated = generateApiKey()
const storedApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: toApiKeyId("record-id"),
  keyId: generated.keyId,
  accountId,
  name: "BTCPay Server" as ApiKeyName,
  hashedKey: generated.hashedSecret,
  scopes: ["read:user"] as ApiKeyScope[],
  status: "active" as ApiKeyStatus,
  ipConstraints: [],
  metadata: {},
  rateLimitPerMinute: null,
  lastUsedAt: null,
  createdAt: new Date(),
  expiresAt: null,
  ...overrides,
})

describe("verifyApiKey", () => {
  let findByKeyId: jest.Mock
  let updateLastUsedAt: jest.Mock
  let findById: jest.Mock

  beforeEach(() => {
    findByKeyId = jest.fn().mockResolvedValue(storedApiKey())
    updateLastUsedAt = jest.fn().mockResolvedValue(undefined)
    mockedApiKeysRepository.mockReturnValue({
      create: jest.fn(),
      findByKeyId,
      findByAccountId: jest.fn(),
      listByAccountId: jest.fn(),
      findActiveByIdForAccount: jest.fn(),
      updateLastUsedAt,
      revoke: jest.fn(),
      revokeAll: jest.fn(),
    })
    findById = jest.fn().mockResolvedValue({ id: accountId, kratosUserId })
    mockedAccountsRepository.mockReturnValue({
      findById,
    } as unknown as ReturnType<typeof AccountsRepository>)
  })

  it("resolves a valid key to its owner's kratos identity", async () => {
    const result = await verifyApiKey({ rawKey: generated.fullKey })
    if (result instanceof Error) throw result

    expect(findByKeyId).toHaveBeenCalledWith(generated.keyId)
    expect(findById).toHaveBeenCalledWith(accountId)
    expect(result.kratosUserId).toBe(kratosUserId)
    expect(result.apiKey.keyId).toBe(generated.keyId)
  })

  it("updates lastUsedAt when stale and skips it when fresh", async () => {
    findByKeyId.mockResolvedValue(
      storedApiKey({ lastUsedAt: new Date(Date.now() - 2 * 60 * 1000) }),
    )
    await verifyApiKey({ rawKey: generated.fullKey })
    expect(updateLastUsedAt).toHaveBeenCalledTimes(1)

    updateLastUsedAt.mockClear()
    findByKeyId.mockResolvedValue(storedApiKey({ lastUsedAt: new Date() }))
    await verifyApiKey({ rawKey: generated.fullKey })
    expect(updateLastUsedAt).not.toHaveBeenCalled()
  })

  it("rejects malformed keys without touching the repository", async () => {
    const result = await verifyApiKey({ rawKey: "fk_nope" })

    expect(result).toBeInstanceOf(InvalidApiKeyFormatError)
    expect(findByKeyId).not.toHaveBeenCalled()
  })

  it("propagates a missing key as CouldNotFindError", async () => {
    findByKeyId.mockResolvedValue(new CouldNotFindError("API key not found"))

    expect(await verifyApiKey({ rawKey: generated.fullKey })).toBeInstanceOf(
      CouldNotFindError,
    )
  })

  it("rejects expired keys", async () => {
    findByKeyId.mockResolvedValue(
      storedApiKey({ expiresAt: new Date(Date.now() - 1000) }),
    )

    const result = await verifyApiKey({ rawKey: generated.fullKey })

    expect(result).toBeInstanceOf(ApiKeyExpiredError)
    expect(findById).not.toHaveBeenCalled()
  })

  it("rejects a wrong secret for an existing keyId", async () => {
    const other = generateApiKey()
    const forged = `fk_${generated.keyId}_${other.secret}`

    const result = await verifyApiKey({ rawKey: forged })

    expect(result).toBeInstanceOf(ApiKeySecretMismatchError)
    expect(findById).not.toHaveBeenCalled()
    expect(updateLastUsedAt).not.toHaveBeenCalled()
  })

  it("propagates account lookup failures", async () => {
    findById.mockResolvedValue(new UnknownRepositoryError("boom"))

    expect(await verifyApiKey({ rawKey: generated.fullKey })).toBeInstanceOf(
      UnknownRepositoryError,
    )
  })

  describe("ipConstraints", () => {
    it("passes when the request IP matches a constraint", async () => {
      findByKeyId.mockResolvedValue(
        storedApiKey({ ipConstraints: ["10.0.0.0/8", "203.0.113.7"] }),
      )

      const result = await verifyApiKey({
        rawKey: generated.fullKey,
        requestIp: "10.1.2.3",
      })
      if (result instanceof Error) throw result

      expect(result.kratosUserId).toBe(kratosUserId)
    })

    it("rejects a non-matching request IP", async () => {
      findByKeyId.mockResolvedValue(storedApiKey({ ipConstraints: ["10.0.0.0/8"] }))

      const result = await verifyApiKey({
        rawKey: generated.fullKey,
        requestIp: "192.0.2.1",
      })

      expect(result).toBeInstanceOf(ApiKeyIpNotAllowedError)
      expect(findById).not.toHaveBeenCalled()
    })

    it("fails closed when the request IP is unavailable", async () => {
      findByKeyId.mockResolvedValue(storedApiKey({ ipConstraints: ["10.0.0.0/8"] }))

      const result = await verifyApiKey({ rawKey: generated.fullKey })

      expect(result).toBeInstanceOf(ApiKeyIpNotAllowedError)
      expect(findById).not.toHaveBeenCalled()
    })

    it("still passes an unconstrained key with no request IP", async () => {
      const result = await verifyApiKey({ rawKey: generated.fullKey })
      if (result instanceof Error) throw result

      expect(result.kratosUserId).toBe(kratosUserId)
    })
  })
})
