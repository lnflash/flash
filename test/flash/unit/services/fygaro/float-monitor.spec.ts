import { USDTAmount, WalletCurrency } from "@domain/shared"

const mockFygaroConfig = {
  enabled: true,
  float: { floorUsd: 2000 } as { floorUsd: number } | undefined,
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockGetBankOwnerWalletId = jest.fn()
jest.mock("@services/ledger/caching", () => ({
  getBankOwnerWalletId: (...args: unknown[]) => mockGetBankOwnerWalletId(...args),
}))

const mockGetAccountDetails = jest.fn()
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountDetails: (...args: unknown[]) => mockGetAccountDetails(...args),
  },
}))

const mockAlertBridge = jest.fn()
jest.mock("@services/alerts", () => ({
  alertBridge: (...args: unknown[]) => mockAlertBridge(...args),
  generateDedupKey: {
    fygaroFloatLow: () => "fygaro:float-low",
  },
}))

import { checkFygaroTreasuryFloat } from "@services/fygaro/float-monitor"

const WALLET_ID = "bankowner-usdt-wallet" as WalletId

const usdt = (dollars: string): USDTAmount => {
  const amt = USDTAmount.fromNumber(dollars)
  if (amt instanceof Error) throw amt
  return amt
}

const detailsWithBalance = (balance: USDTAmount | undefined) => ({
  id: WALLET_ID,
  userId: "u",
  name: "bankowner",
  balance,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.enabled = true
  mockFygaroConfig.float = { floorUsd: 2000 }
  mockGetBankOwnerWalletId.mockResolvedValue(WALLET_ID)
  mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("5000")))
})

describe("checkFygaroTreasuryFloat", () => {
  it("reads the bankowner USDT balance from IBEX", async () => {
    await checkFygaroTreasuryFloat()

    expect(mockGetBankOwnerWalletId).toHaveBeenCalled()
    expect(mockGetAccountDetails).toHaveBeenCalledWith(WALLET_ID, WalletCurrency.Usdt)
  })

  it("alerts (warning) when the balance is below the floor", async () => {
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1500")))

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).toHaveBeenCalledTimes(1)
    const alert = mockAlertBridge.mock.calls[0][0]
    expect(alert).toMatchObject({
      dedupKey: "fygaro:float-low",
      source: "fygaro-webhook",
      severity: "warning",
    })
    expect(alert.title).toMatch(/float low/i)
    expect(alert.context).toEqual({ balance_usd: 1500, floor_usd: 2000 })
  })

  it("treats an absent (drained account) balance as zero and alerts", async () => {
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(undefined))

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).toHaveBeenCalledTimes(1)
    expect(mockAlertBridge.mock.calls[0][0].context).toEqual({
      balance_usd: 0,
      floor_usd: 2000,
    })
  })

  it("does NOT alert when the balance equals the floor", async () => {
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("2000")))

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("does NOT alert when the balance is above the floor", async () => {
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("2500")))

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("does not crash and does not alert when the IBEX read fails", async () => {
    mockGetAccountDetails.mockResolvedValue(new Error("ibex unreachable"))

    await expect(checkFygaroTreasuryFloat()).resolves.toBeUndefined()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("does not crash when the wallet resolver throws", async () => {
    mockGetBankOwnerWalletId.mockRejectedValue(new Error("no bankowner"))

    await expect(checkFygaroTreasuryFloat()).resolves.toBeUndefined()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("skips entirely when the fygaro feature is disabled", async () => {
    mockFygaroConfig.enabled = false

    await checkFygaroTreasuryFloat()

    expect(mockGetBankOwnerWalletId).not.toHaveBeenCalled()
    expect(mockGetAccountDetails).not.toHaveBeenCalled()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("falls back to the default floor when float config is absent", async () => {
    mockFygaroConfig.float = undefined
    // Default floor is 2000; 1000 is below it.
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1000")))

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).toHaveBeenCalledTimes(1)
    expect(mockAlertBridge.mock.calls[0][0].context).toEqual({
      balance_usd: 1000,
      floor_usd: 2000,
    })
  })
})
