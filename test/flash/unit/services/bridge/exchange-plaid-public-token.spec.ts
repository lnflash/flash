jest.mock("@config", () => ({
  BridgeConfig: { enabled: true },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/schema", () => ({
  BridgeVirtualAccount: {},
}))

jest.mock("@services/mongoose/wallets", () => ({
  WalletsRepository: jest.fn(),
}))

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: <F extends object>({ fns }: { fns: F }) => fns,
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@app/wallets/get-balance-for-wallet", () => ({
  getBalanceForWallet: jest.fn(),
}))

jest.mock("@app/bridge/send-withdrawal-notification", () => ({
  sendBridgeWithdrawalNotificationBestEffort: jest.fn(),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: jest.fn(),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {},
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeBridgeCashoutPending: jest.fn(),
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: {
    exchangePlaidPublicToken: jest.fn(),
    createPlaidLinkRequest: jest.fn(),
    getExternalAccountLinkUrl: jest.fn(),
  },
}))

const mockCacheSet = jest.fn()
const mockCacheGet = jest.fn()
const mockCacheClear = jest.fn()
const mockCacheConsume = jest.fn()

jest.mock("@services/cache", () => ({
  RedisCacheService: () => ({
    set: mockCacheSet,
    get: mockCacheGet,
    clear: mockCacheClear,
  }),
  // Lazy wrapper: the factory is hoisted above the const, so reference
  // mockCacheConsume only when called, not at factory-eval time.
  consumeCacheKey: (args: { key: string }) => mockCacheConsume(args),
}))

import BridgeService from "@services/bridge"
import BridgeApiClient from "@services/bridge/client"
import { AccountsRepository } from "@services/mongoose/accounts"
import {
  BridgeApiError,
  BridgeError,
  BridgeInvalidPlaidTokenError,
  BridgePlaidNotAvailableError,
} from "@services/bridge/errors"
import { CacheUndefinedError, UnknownCacheServiceError } from "@domain/cache"

const ACCOUNT_ID = "account-001" as AccountId
const OTHER_ACCOUNT_ID = "account-002" as AccountId

const futureExpiresAt = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()

const bindTokenForAccount = (
  linkToken: string,
  accountId: AccountId = ACCOUNT_ID,
  expiresAt = futureExpiresAt(),
) => {
  mockCacheGet.mockResolvedValue({
    accountId,
    bridgeCustomerId: "cust_1",
    expiresAt,
  })
  mockCacheClear.mockResolvedValue(true)
  mockCacheConsume.mockResolvedValue(true)
  return { linkToken, accountId, expiresAt }
}

const mockAccount = (overrides: Record<string, unknown> = {}) => {
  ;(AccountsRepository as jest.Mock).mockReturnValue({
    findById: jest.fn().mockResolvedValue({
      id: ACCOUNT_ID,
      level: 1,
      bridgeCustomerId: "cust_1",
      ...overrides,
    }),
  })
}

describe("BridgeService.exchangePlaidPublicToken", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAccount()
    mockCacheGet.mockResolvedValue(new CacheUndefinedError())
    mockCacheClear.mockResolvedValue(true)
    mockCacheConsume.mockResolvedValue(true)
  })

  it("rejects empty or whitespace tokens with BridgeInvalidPlaidTokenError", async () => {
    for (const [linkToken, publicToken] of [
      ["", "public-ok"],
      ["   ", "public-ok"],
      ["link-ok", ""],
      ["link-ok", "   "],
    ]) {
      const result = await BridgeService.exchangePlaidPublicToken(
        ACCOUNT_ID,
        linkToken,
        publicToken,
      )
      expect(result).toBeInstanceOf(BridgeInvalidPlaidTokenError)
    }
    expect(BridgeApiClient.exchangePlaidPublicToken).not.toHaveBeenCalled()
    expect(mockCacheGet).not.toHaveBeenCalled()
  })

  it("rejects tokens that were never issued (or already consumed)", async () => {
    mockCacheGet.mockResolvedValue(new CacheUndefinedError())

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )

    expect(result).toBeInstanceOf(BridgeInvalidPlaidTokenError)
    expect((result as Error).message).toMatch(/Unknown or already-used/)
    expect(BridgeApiClient.exchangePlaidPublicToken).not.toHaveBeenCalled()
  })

  it("rejects tokens issued to a different Flash account", async () => {
    bindTokenForAccount("link-1", OTHER_ACCOUNT_ID)

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )

    expect(result).toBeInstanceOf(BridgeInvalidPlaidTokenError)
    expect((result as Error).message).toMatch(/not issued for this account/)
    expect(BridgeApiClient.exchangePlaidPublicToken).not.toHaveBeenCalled()
    // A stranger must not be able to burn the owner's token: ownership is
    // checked on the non-destructive get, before the atomic consume.
    expect(mockCacheClear).not.toHaveBeenCalled()
    expect(mockCacheConsume).not.toHaveBeenCalled()
  })

  it("rejects expired bound tokens without calling Bridge", async () => {
    bindTokenForAccount("link-1", ACCOUNT_ID, new Date(Date.now() - 1000).toISOString())

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )

    expect(result).toBeInstanceOf(BridgeInvalidPlaidTokenError)
    expect((result as Error).message).toMatch(/expired/)
    expect(BridgeApiClient.exchangePlaidPublicToken).not.toHaveBeenCalled()
    expect(mockCacheClear).toHaveBeenCalledWith({ key: "plaid:link:link-1" })
  })

  it("trims tokens, consumes the binding, then exchanges with Bridge", async () => {
    bindTokenForAccount("link-1")
    ;(BridgeApiClient.exchangePlaidPublicToken as jest.Mock).mockResolvedValue({
      message: "ok",
    })

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "  link-1  ",
      "  public-1  ",
    )

    expect(mockCacheGet).toHaveBeenCalledWith({ key: "plaid:link:link-1" })
    // Consume goes through the atomic gate, not the non-gating clear().
    expect(mockCacheConsume).toHaveBeenCalledWith({ key: "plaid:link:link-1" })
    expect(mockCacheClear).not.toHaveBeenCalled()
    expect(BridgeApiClient.exchangePlaidPublicToken).toHaveBeenCalledWith(
      "link-1",
      "public-1",
    )
    expect(result).toEqual({ message: "ok" })
  })

  it("consumes the token: a second exchange of the same token is rejected", async () => {
    bindTokenForAccount("link-1")
    ;(BridgeApiClient.exchangePlaidPublicToken as jest.Mock).mockResolvedValue({
      message: "ok",
    })

    // First exchange atomically removes the binding (DEL removed 1 key)...
    mockCacheConsume.mockResolvedValueOnce(true)
    const first = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )
    expect(first).toEqual({ message: "ok" })

    // ...so the second is rejected because its DEL removes nothing (0 keys),
    // even though the stateless get still returns a binding.
    mockCacheConsume.mockResolvedValueOnce(false)
    const second = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )
    expect(second).toBeInstanceOf(BridgeInvalidPlaidTokenError)
    expect((second as Error).message).toMatch(/Unknown or already-used/)
    expect(BridgeApiClient.exchangePlaidPublicToken).toHaveBeenCalledTimes(1)
  })

  it("lets only one of two concurrent exchanges of the same token through", async () => {
    bindTokenForAccount("link-1")
    ;(BridgeApiClient.exchangePlaidPublicToken as jest.Mock).mockResolvedValue({
      message: "ok",
    })
    // Model the atomic DEL under concurrency: exactly one caller removes the key.
    // (With the old get-then-clear this would resolve true for both and both
    // would reach Bridge — the race this test guards against.)
    mockCacheConsume.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const outcomes = await Promise.all([
      BridgeService.exchangePlaidPublicToken(ACCOUNT_ID, "link-1", "public-1"),
      BridgeService.exchangePlaidPublicToken(ACCOUNT_ID, "link-1", "public-1"),
    ])

    const successes = outcomes.filter((r) => !(r instanceof Error))
    const rejected = outcomes.filter(
      (r) => r instanceof BridgeInvalidPlaidTokenError,
    )
    expect(successes).toEqual([{ message: "ok" }])
    expect(rejected).toHaveLength(1)
    // The losing exchange never reaches Bridge.
    expect(BridgeApiClient.exchangePlaidPublicToken).toHaveBeenCalledTimes(1)
  })

  it("maps Bridge 400 (rejected token pair) to BridgeInvalidPlaidTokenError with detail", async () => {
    bindTokenForAccount("link-1")
    ;(BridgeApiClient.exchangePlaidPublicToken as jest.Mock).mockRejectedValue(
      new BridgeApiError("Bridge API error: 400 Bad Request", 400, {
        message: "link_token has expired",
      }),
    )

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )

    expect(result).toBeInstanceOf(BridgeInvalidPlaidTokenError)
    expect((result as Error).message).toBe("link_token has expired")
  })

  it("maps Bridge 400 without response detail to a fallback message", async () => {
    bindTokenForAccount("link-1")
    ;(BridgeApiClient.exchangePlaidPublicToken as jest.Mock).mockRejectedValue(
      new BridgeApiError("Bridge API error: 400 Bad Request", 400, null),
    )

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )

    expect(result).toBeInstanceOf(BridgeInvalidPlaidTokenError)
    expect((result as Error).message).toMatch(/restart bank linking/i)
  })

  it("maps Bridge 401/403 to BridgePlaidNotAvailableError", async () => {
    for (const status of [401, 403]) {
      jest.clearAllMocks()
      mockAccount()
      bindTokenForAccount("link-1")
      ;(BridgeApiClient.exchangePlaidPublicToken as jest.Mock).mockRejectedValue(
        new BridgeApiError(`Bridge API error: ${status}`, status, null),
      )

      const result = await BridgeService.exchangePlaidPublicToken(
        ACCOUNT_ID,
        "link-1",
        "public-1",
      )

      expect(result).toBeInstanceOf(BridgePlaidNotAvailableError)
    }
  })

  it("passes through Bridge 5xx as the raw error (alerting path)", async () => {
    bindTokenForAccount("link-1")
    const serverError = new BridgeApiError("Bridge API error: 500", 500, null)
    ;(BridgeApiClient.exchangePlaidPublicToken as jest.Mock).mockRejectedValue(
      serverError,
    )

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )

    expect(result).toBe(serverError)
  })

  it("requires a Bridge customer ID (KYC) before exchanging", async () => {
    mockAccount({ bridgeCustomerId: undefined })

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "link-1",
      "public-1",
    )

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/Complete KYC first/)
    expect(BridgeApiClient.exchangePlaidPublicToken).not.toHaveBeenCalled()
    expect(mockCacheGet).not.toHaveBeenCalled()
  })
})

describe("BridgeService.addExternalAccount (deprecated linkUrl compat)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAccount()
    mockCacheSet.mockResolvedValue({ accountId: ACCOUNT_ID })
    ;(BridgeApiClient.createPlaidLinkRequest as jest.Mock).mockResolvedValue({
      link_token: "link-token-1",
      link_token_expires_at: "2026-07-15T00:00:00Z",
      callback_url: "https://example.test/cb",
    })
  })

  it("returns both linkToken and the hosted linkUrl while clients migrate", async () => {
    ;(BridgeApiClient.getExternalAccountLinkUrl as jest.Mock).mockResolvedValue({
      link_url: "https://hosted.bridge.test/link",
      expires_at: "2026-07-15T00:00:00Z",
    })

    const result = await BridgeService.addExternalAccount(ACCOUNT_ID)

    expect(mockCacheSet).toHaveBeenCalledWith({
      key: "plaid:link:link-token-1",
      value: {
        accountId: ACCOUNT_ID,
        bridgeCustomerId: "cust_1",
        expiresAt: "2026-07-15T00:00:00Z",
      },
      ttlSecs: expect.any(Number),
    })
    expect(result).toEqual({
      linkToken: "link-token-1",
      linkUrl: "https://hosted.bridge.test/link",
      expiresAt: "2026-07-15T00:00:00Z",
    })
  })

  it("still succeeds with linkUrl null when the hosted endpoint fails", async () => {
    ;(BridgeApiClient.getExternalAccountLinkUrl as jest.Mock).mockRejectedValue(
      new BridgeApiError("Bridge API error: 404", 404, null),
    )

    const result = await BridgeService.addExternalAccount(ACCOUNT_ID)

    expect(result).toEqual({
      linkToken: "link-token-1",
      linkUrl: null,
      expiresAt: "2026-07-15T00:00:00Z",
    })
  })

  it("fails closed when the link-token binding cannot be persisted", async () => {
    mockCacheSet.mockResolvedValue(new UnknownCacheServiceError("redis down"))

    const result = await BridgeService.addExternalAccount(ACCOUNT_ID)

    expect(result).toBeInstanceOf(BridgeError)
    expect((result as Error).message).toMatch(/Unable to start bank linking/)
    expect(BridgeApiClient.getExternalAccountLinkUrl).not.toHaveBeenCalled()
  })
})
