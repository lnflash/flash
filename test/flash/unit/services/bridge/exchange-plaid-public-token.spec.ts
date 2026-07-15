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

import BridgeService from "@services/bridge"
import BridgeApiClient from "@services/bridge/client"
import { AccountsRepository } from "@services/mongoose/accounts"
import {
  BridgeApiError,
  BridgeInvalidPlaidTokenError,
  BridgePlaidNotAvailableError,
} from "@services/bridge/errors"

const ACCOUNT_ID = "account-001" as AccountId

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
  })

  it("trims tokens before exchanging with Bridge", async () => {
    ;(BridgeApiClient.exchangePlaidPublicToken as jest.Mock).mockResolvedValue({
      message: "ok",
    })

    const result = await BridgeService.exchangePlaidPublicToken(
      ACCOUNT_ID,
      "  link-1  ",
      "  public-1  ",
    )

    expect(BridgeApiClient.exchangePlaidPublicToken).toHaveBeenCalledWith(
      "link-1",
      "public-1",
    )
    expect(result).toEqual({ message: "ok" })
  })

  it("maps Bridge 400 (rejected token pair) to BridgeInvalidPlaidTokenError with detail", async () => {
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
  })
})

describe("BridgeService.addExternalAccount (deprecated linkUrl compat)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAccount()
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
})
