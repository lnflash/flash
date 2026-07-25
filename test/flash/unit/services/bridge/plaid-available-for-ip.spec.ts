// Unit tests for BridgeService.plaidGateForIp — the US-only Plaid gate.
// Plaid onboarding is US-only, so a non-US egress IP must be routed to manual
// entry (BRIDGE_PLAID_NOT_AVAILABLE) rather than opening a Plaid session it
// can't complete. The gate is fail-open: only a CONFIRMED non-US IP blocks.

jest.mock("@config", () => ({
  BridgeConfig: { enabled: true },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({}))
jest.mock("@services/mongoose/accounts", () => ({ AccountsRepository: jest.fn() }))
jest.mock("@services/mongoose/schema", () => ({ BridgeVirtualAccount: {} }))
jest.mock("@services/mongoose/wallets", () => ({ WalletsRepository: jest.fn() }))

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: <F extends object>({ fns }: { fns: F }) => fns,
  recordExceptionInCurrentSpan: jest.fn(),
  addAttributesToCurrentSpan: jest.fn(),
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
jest.mock("@services/kratos", () => ({ IdentityRepository: jest.fn() }))
jest.mock("@services/ibex/client", () => ({ __esModule: true, default: {} }))
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
jest.mock("@services/cache", () => ({
  RedisCacheService: () => ({ set: jest.fn(), get: jest.fn(), clear: jest.fn() }),
  consumeCacheKey: jest.fn(),
}))

const mockFetchIPInfo = jest.fn()
jest.mock("@services/ipfetcher", () => ({
  IpFetcher: () => ({ fetchIPInfo: mockFetchIPInfo }),
}))

import BridgeService from "@services/bridge"
import { UnknownIpFetcherServiceError } from "@domain/ipfetcher"
import { addAttributesToCurrentSpan } from "@services/tracing"

const mockAddAttributes = addAttributesToCurrentSpan as jest.Mock

const ip = (value: string) => value as unknown as IpAddress

const ipInfo = (isoCode: string) => ({
  provider: "test",
  country: isoCode === "US" ? "United States" : "Jamaica",
  isoCode,
  region: "",
  city: "",
  type: "",
  asn: "AS0",
  proxy: false,
})

describe("BridgeService.plaidGateForIp", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("blocks a confirmed non-US IP (Jamaica) and tags the span", async () => {
    mockFetchIPInfo.mockResolvedValue(ipInfo("JM"))
    // 69.160.103.177 = Digicel Jamaica — the real reported case.
    const result = await BridgeService.plaidGateForIp(ip("69.160.103.177"))

    expect(result).toEqual({ available: false, country: "JM" })
    expect(mockFetchIPInfo).toHaveBeenCalledWith("69.160.103.177")
    // Observability: the block decision is visible on the span.
    expect(mockAddAttributes).toHaveBeenCalledWith({
      "plaid.gate.decision": "blocked-non-us",
      "plaid.gate.country": "JM",
    })
  })

  it("allows a US IP", async () => {
    mockFetchIPInfo.mockResolvedValue(ipInfo("US"))
    const result = await BridgeService.plaidGateForIp(ip("8.8.8.8"))

    expect(result).toEqual({ available: true, country: "US" })
    expect(mockAddAttributes).toHaveBeenCalledWith({
      "plaid.gate.decision": "allowed-us",
      "plaid.gate.country": "US",
    })
  })

  it("treats isoCode case-insensitively", async () => {
    mockFetchIPInfo.mockResolvedValue(ipInfo("us"))
    expect((await BridgeService.plaidGateForIp(ip("8.8.8.8"))).available).toBe(true)

    mockFetchIPInfo.mockResolvedValue(ipInfo("jm"))
    const jm = await BridgeService.plaidGateForIp(ip("69.160.103.177"))
    expect(jm.available).toBe(false)
    expect(jm.country).toBe("JM")
  })

  it("geo-checks an IPv6 client instead of crashing (blocks non-US)", async () => {
    // isPrivateIp throws on a real IPv6 address; the gate must swallow that and
    // still geo-check, not throw out of the mutation.
    mockFetchIPInfo.mockResolvedValue(ipInfo("JM"))
    const result = await BridgeService.plaidGateForIp(ip("2607:fb90:abcd::1"))

    expect(result).toEqual({ available: false, country: "JM" })
    expect(mockFetchIPInfo).toHaveBeenCalledWith("2607:fb90:abcd::1")
  })

  it("allows a US IPv6 client", async () => {
    mockFetchIPInfo.mockResolvedValue(ipInfo("US"))
    expect((await BridgeService.plaidGateForIp(ip("2607:fb90:abcd::1"))).available).toBe(
      true,
    )
  })

  it("fails open (allows) when no IP is available — no lookup", async () => {
    const result = await BridgeService.plaidGateForIp(undefined)
    expect(result).toEqual({ available: true, country: null })
    expect(mockFetchIPInfo).not.toHaveBeenCalled()
  })

  it("fails open (allows) for a private/dev IP — no lookup", async () => {
    const result = await BridgeService.plaidGateForIp(ip("192.168.1.10"))
    expect(result).toEqual({ available: true, country: null })
    expect(mockFetchIPInfo).not.toHaveBeenCalled()
  })

  it("fails open (allows) when the geo lookup errors", async () => {
    mockFetchIPInfo.mockResolvedValue(new UnknownIpFetcherServiceError("boom"))
    const result = await BridgeService.plaidGateForIp(ip("69.160.103.177"))
    expect(result).toEqual({ available: true, country: null })
  })

  it("fails open (allows) when the country is unknown (empty isoCode)", async () => {
    mockFetchIPInfo.mockResolvedValue(ipInfo(""))
    const result = await BridgeService.plaidGateForIp(ip("69.160.103.177"))
    expect(result).toEqual({ available: true, country: null })
  })
})
