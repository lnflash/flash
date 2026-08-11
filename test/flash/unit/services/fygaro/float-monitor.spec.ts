import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

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

const mockFindByRole = jest.fn()
const mockListByAccountId = jest.fn()
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findByRole: (...args: unknown[]) => mockFindByRole(...args),
  }),
  WalletsRepository: () => ({
    listByAccountId: (...args: unknown[]) => mockListByAccountId(...args),
  }),
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

const TREASURY_ACCOUNT_ID = "bankowner-account" as AccountId
const USDT_WALLET_ID = "bankowner-usdt-wallet" as WalletId
const USD_WALLET_ID = "bankowner-usd-wallet" as WalletId
const BTC_WALLET_ID = "bankowner-btc-wallet" as WalletId

const usdtWallet = {
  id: USDT_WALLET_ID,
  accountId: TREASURY_ACCOUNT_ID,
  currency: WalletCurrency.Usdt,
} as unknown as Wallet
const usdWallet = {
  id: USD_WALLET_ID,
  accountId: TREASURY_ACCOUNT_ID,
  currency: WalletCurrency.Usd,
} as unknown as Wallet
const btcWallet = {
  id: BTC_WALLET_ID,
  accountId: TREASURY_ACCOUNT_ID,
  currency: WalletCurrency.Btc,
} as unknown as Wallet

const usdt = (dollars: string): USDTAmount => {
  const amt = USDTAmount.fromNumber(dollars)
  if (amt instanceof Error) throw amt
  return amt
}

const usd = (dollars: string): USDAmount => {
  const amt = USDAmount.dollars(dollars)
  if (amt instanceof Error) throw amt
  return amt
}

const detailsWithBalance = (balance: USDTAmount | USDAmount | undefined) => ({
  id: USDT_WALLET_ID,
  userId: "u",
  name: "bankowner",
  balance,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.enabled = true
  mockFygaroConfig.float = { floorUsd: 2000 }
  mockFindByRole.mockResolvedValue({ id: TREASURY_ACCOUNT_ID })
  // USD wallet listed first on purpose: selection must pick the USDT wallet by
  // currency, not by list order.
  mockListByAccountId.mockResolvedValue([usdWallet, usdtWallet])
  mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("5000")))
})

describe("checkFygaroTreasuryFloat", () => {
  it("reads the balance of the treasury's USDT funding wallet from IBEX", async () => {
    await checkFygaroTreasuryFloat()

    expect(mockFindByRole).toHaveBeenCalledWith("bankowner")
    expect(mockListByAccountId).toHaveBeenCalledWith(TREASURY_ACCOUNT_ID)
    // The wallet queried MUST be the same one auto-credit spends from: the USDT
    // wallet, read in its own currency — not the account's default (USD) wallet.
    expect(mockGetAccountDetails).toHaveBeenCalledWith(
      USDT_WALLET_ID,
      WalletCurrency.Usdt,
    )
  })

  it("falls back to the legacy USD wallet when the treasury has no USDT wallet", async () => {
    mockListByAccountId.mockResolvedValue([usdWallet])
    // A funded USD wallet above the floor must NOT alert (and must be read in
    // USD, not mis-parsed as a zero USDT balance).
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usd("5000")))

    await checkFygaroTreasuryFloat()

    expect(mockGetAccountDetails).toHaveBeenCalledWith(USD_WALLET_ID, WalletCurrency.Usd)
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("alerts on a low USD-wallet fallback balance (scored in USD, not as zero)", async () => {
    mockListByAccountId.mockResolvedValue([usdWallet])
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usd("1500")))

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).toHaveBeenCalledTimes(1)
    expect(mockAlertBridge.mock.calls[0][0].context).toEqual({
      balance_usd: 1500,
      floor_usd: 2000,
    })
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

  it("does not read IBEX or alert when the treasury account cannot be resolved", async () => {
    mockFindByRole.mockResolvedValue(new Error("no bankowner"))

    await expect(checkFygaroTreasuryFloat()).resolves.toBeUndefined()
    expect(mockListByAccountId).not.toHaveBeenCalled()
    expect(mockGetAccountDetails).not.toHaveBeenCalled()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("does not read IBEX or alert when listing treasury wallets fails", async () => {
    mockListByAccountId.mockResolvedValue(new Error("mongo down"))

    await expect(checkFygaroTreasuryFloat()).resolves.toBeUndefined()
    expect(mockGetAccountDetails).not.toHaveBeenCalled()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("does not read IBEX or alert when the treasury has no USDT or USD wallet", async () => {
    mockListByAccountId.mockResolvedValue([btcWallet])

    await expect(checkFygaroTreasuryFloat()).resolves.toBeUndefined()
    expect(mockGetAccountDetails).not.toHaveBeenCalled()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("does not crash when the wallet resolver throws", async () => {
    mockFindByRole.mockRejectedValue(new Error("boom"))

    await expect(checkFygaroTreasuryFloat()).resolves.toBeUndefined()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("skips entirely when the fygaro feature is disabled", async () => {
    mockFygaroConfig.enabled = false

    await checkFygaroTreasuryFloat()

    expect(mockFindByRole).not.toHaveBeenCalled()
    expect(mockListByAccountId).not.toHaveBeenCalled()
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
