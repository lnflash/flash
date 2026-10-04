import { ApiError } from "ibex-client"

import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import { IbexError } from "@services/ibex/errors"

type FloatCfg = {
  floorUsd: number
  criticalFloorUsd?: number
  criticalRunwayDays?: number
  fundUrl?: string
}
const defaultFloat = (): FloatCfg => ({
  floorUsd: 2000,
  criticalFloorUsd: 500,
  criticalRunwayDays: 3,
  fundUrl: "https://erp.example/app/system-accounts",
})
const mockFygaroConfig = {
  enabled: true,
  credit: { enabled: true } as { enabled: boolean } | undefined,
  float: defaultFloat() as FloatCfg | undefined,
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
    fygaroFloatCritical: () => "fygaro:float-critical",
  },
}))

// Trailing-7-day net credited (cents), the burn the runway is computed from.
// Default: $700 over 7 days = $100/day, so a $5000 float has 50 days of runway.
const mockSumNet = jest.fn()
jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  sumFygaroCreditedNetCentsLastDays: (...args: unknown[]) => mockSumNet(...args),
}))

// The cron is a one-shot Job, so cross-run rate limiting is a Redis NX marker,
// not the in-memory alert dedup. Mock redis.set so tests drive the claim path.
const mockRedisSet = jest.fn()
jest.mock("@services/redis", () => ({
  redis: { set: (...args: unknown[]) => mockRedisSet(...args) },
}))

import {
  checkFygaroTreasuryFloat,
  classifyFloat,
  computeRunwayDays,
} from "@services/fygaro/float-monitor"

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

// A drained / never-funded IBEX account answers getAccountDetails with an HTTP
// 404 IbexError — the codebase's documented empty-account drain signal
// (get-balance-for-wallet.ts maps 404 -> ZERO). The float monitor reads through
// that helper, so this MUST be scored as an empty float, not swallowed as a read
// blip.
const ibex404 = (): IbexError =>
  new IbexError(
    new ApiError(Object.assign(new Error("account not found"), { status: 404 })),
  )

// A genuine read blip: an IBEX error that is NOT a 404. getBalanceForWallet
// surfaces this as an error (never ZERO), so the monitor must bail without
// alerting. (Ibex.getAccountDetails returns IbexError on failure — never a bare
// Error — so this is what a real read failure looks like.)
const ibexReadBlip = (): IbexError => new IbexError(new Error("ibex unreachable"))

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.enabled = true
  mockFygaroConfig.credit = { enabled: true }
  mockFygaroConfig.float = defaultFloat()
  mockSumNet.mockResolvedValue(70000)
  mockFindByRole.mockResolvedValue({ id: TREASURY_ACCOUNT_ID })
  // USD wallet listed first on purpose: selection must pick the USDT wallet by
  // currency, not by list order.
  mockListByAccountId.mockResolvedValue([usdWallet, usdtWallet])
  mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("5000")))
  // Default: the cross-run Redis marker is claimable (NX SET succeeds).
  mockRedisSet.mockResolvedValue("OK")
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
    // USD, not misread as a zero USDT balance).
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
    expect(mockAlertBridge.mock.calls[0][0].context).toMatchObject({
      balance_usd: 1500,
      floor_usd: 2000,
    })
  })

  it("suppresses the float-low alert across runs when the Redis marker is already set", async () => {
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1500")))
    // NX SET returns null when the key already exists (a prior run alerted
    // within the window) — the one-shot cron must not re-page.
    mockRedisSet.mockResolvedValue(null)

    await checkFygaroTreasuryFloat()

    expect(mockRedisSet).toHaveBeenCalledWith(
      "fygaro:float-low:alerted",
      "1",
      "EX",
      3600,
      "NX",
    )
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("alerts anyway when the Redis dedup marker is unavailable (fail-open, never silent)", async () => {
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1500")))
    mockRedisSet.mockRejectedValue(new Error("redis down"))

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).toHaveBeenCalledTimes(1)
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
    expect(alert.context).toMatchObject({ balance_usd: 1500, floor_usd: 2000 })
  })

  it("treats an absent (drained account) balance as zero and pages CRITICAL", async () => {
    mockGetAccountDetails.mockResolvedValue(detailsWithBalance(undefined))

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).toHaveBeenCalledTimes(1)
    expect(mockAlertBridge.mock.calls[0][0]).toMatchObject({
      dedupKey: "fygaro:float-critical",
      severity: "critical",
    })
    expect(mockAlertBridge.mock.calls[0][0].context).toMatchObject({
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

  it("does not crash and does not alert when the IBEX read fails (non-404 blip)", async () => {
    mockGetAccountDetails.mockResolvedValue(ibexReadBlip())

    await expect(checkFygaroTreasuryFloat()).resolves.toBeUndefined()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("alerts with balance_usd 0 when IBEX 404s the drained treasury account", async () => {
    // Regression: reading Ibex.getAccountDetails directly surfaced a 404 as an
    // IbexError, hit the `instanceof Error` bail, and returned WITHOUT alerting —
    // silently missing the empty-float condition. Routed through
    // getBalanceForWallet the 404 collapses to ZERO and MUST trip the low-float
    // alert.
    mockGetAccountDetails.mockResolvedValue(ibex404())

    await checkFygaroTreasuryFloat()

    expect(mockAlertBridge).toHaveBeenCalledTimes(1)
    const alert = mockAlertBridge.mock.calls[0][0]
    // An EMPTY float is the critical tier, not the warning one.
    expect(alert).toMatchObject({
      dedupKey: "fygaro:float-critical",
      source: "fygaro-webhook",
      severity: "critical",
    })
    expect(alert.context).toMatchObject({ balance_usd: 0, floor_usd: 2000 })
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

  it("skips entirely during the record-only phase (auto-credit disabled)", async () => {
    // fygaro.enabled=true but credit.enabled=false: the webhook only records
    // payments, nothing spends from the treasury, so the monitor must do no
    // repository/IBEX read and fire no page — paging "top up bankowner" here
    // would be premature noise contradicting the alert's own instruction.
    mockFygaroConfig.credit = { enabled: false }

    await checkFygaroTreasuryFloat()

    expect(mockFindByRole).not.toHaveBeenCalled()
    expect(mockListByAccountId).not.toHaveBeenCalled()
    expect(mockGetAccountDetails).not.toHaveBeenCalled()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("skips entirely when the credit config block is absent", async () => {
    mockFygaroConfig.credit = undefined

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
    expect(mockAlertBridge.mock.calls[0][0].context).toMatchObject({
      balance_usd: 1000,
      floor_usd: 2000,
    })
  })
  describe("runway and escalation", () => {
    it("reports daily burn and runway from the trailing-7-day net credited", async () => {
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1500")))
      mockSumNet.mockResolvedValue(70000) // $700 / 7d = $100/day → 15 days

      const reading = await checkFygaroTreasuryFloat()

      expect(mockSumNet).toHaveBeenCalledWith({ days: 7 })
      expect(reading).toMatchObject({
        balanceUsd: 1500,
        dailyBurnUsd: 100,
        runwayDays: 15,
        severity: "warning",
      })
      const alert = mockAlertBridge.mock.calls[0][0]
      expect(alert.context).toMatchObject({
        daily_burn_usd: 100,
        runway_days: 15,
        fund_url: "https://erp.example/app/system-accounts",
      })
      expect(alert.detail).toContain("runway=15.0 days")
      expect(alert.detail).toContain("https://erp.example/app/system-accounts")
    })

    it("reads ERPNext burn on every tick, even when the float is comfortably above the floor", async () => {
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("5000")))
      mockSumNet.mockResolvedValue(70000) // $100/day → 50 days

      const reading = await checkFygaroTreasuryFloat()

      expect(mockSumNet).toHaveBeenCalledWith({ days: 7 })
      expect(reading).toMatchObject({ severity: "ok", dailyBurnUsd: 100, runwayDays: 50 })
      expect(mockAlertBridge).not.toHaveBeenCalled()
    })

    it("escalates to CRITICAL on short runway at a balance well above 2x the floor (burn is never gated on nearness)", async () => {
      // floor=2000, balance=5000, $2000/day burn → 2.5 days < 3. The old
      // nearFloor optimisation skipped the burn read above 2x floor, so this
      // exact case read "ok".
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("5000")))
      mockSumNet.mockResolvedValue(1_400_000)

      const reading = await checkFygaroTreasuryFloat()

      expect(reading).toMatchObject({
        balanceUsd: 5000,
        dailyBurnUsd: 2000,
        runwayDays: 2.5,
        severity: "critical",
      })
      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      expect(mockAlertBridge.mock.calls[0][0]).toMatchObject({
        dedupKey: "fygaro:float-critical",
        severity: "critical",
      })
      expect(mockAlertBridge.mock.calls[0][0].detail).toContain("runway=2.5 days")
    })

    it("escalates to CRITICAL on short runway even when the balance is above the critical floor", async () => {
      // $1500 float, $700/day burn → 2.1 days < 3
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1500")))
      mockSumNet.mockResolvedValue(490000)

      await checkFygaroTreasuryFloat()

      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      expect(mockAlertBridge.mock.calls[0][0]).toMatchObject({
        dedupKey: "fygaro:float-critical",
        severity: "critical",
      })
      expect(mockRedisSet).toHaveBeenCalledWith(
        "fygaro:float-critical:alerted",
        "1",
        "EX",
        3600,
        "NX",
      )
    })

    it("escalates to CRITICAL below the critical floor regardless of runway", async () => {
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("400")))
      mockSumNet.mockResolvedValue(700) // $1/day → 400 days of runway

      await checkFygaroTreasuryFloat()

      expect(mockAlertBridge.mock.calls[0][0]).toMatchObject({
        dedupKey: "fygaro:float-critical",
        severity: "critical",
      })
    })

    it("uses the critical marker, so a critical is not swallowed by an open warning window", async () => {
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("400")))
      // Warning marker already held; critical marker free.
      mockRedisSet.mockImplementation(async (key: string) =>
        key === "fygaro:float-low:alerted" ? null : "OK",
      )

      await checkFygaroTreasuryFloat()

      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      expect(mockAlertBridge.mock.calls[0][0].severity).toBe("critical")
      expect(mockRedisSet).not.toHaveBeenCalledWith(
        "fygaro:float-low:alerted",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      )
    })

    it("still alerts on the floor when the ERPNext burn read fails (runway unknown)", async () => {
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1500")))
      mockSumNet.mockResolvedValue(new Error("erp down"))

      const reading = await checkFygaroTreasuryFloat()

      expect(reading).toMatchObject({
        severity: "warning",
        dailyBurnUsd: undefined,
        runwayDays: undefined,
      })
      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      const alert = mockAlertBridge.mock.calls[0][0]
      expect(alert.severity).toBe("warning")
      expect(alert.detail).toContain("daily_burn=unknown")
      expect(alert.detail).toContain("runway=unknown")
      expect(alert.context).toMatchObject({ daily_burn_usd: null, runway_days: null })
    })

    it("still alerts on the floor when the ERPNext burn read THROWS", async () => {
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1500")))
      mockSumNet.mockRejectedValue(new Error("boom"))

      const reading = await checkFygaroTreasuryFloat()

      // The ERP is an input to runway, never a gate on the balance alert.
      expect(reading).toMatchObject({ severity: "warning", runwayDays: undefined })
      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      expect(mockAlertBridge.mock.calls[0][0].severity).toBe("warning")
    })

    it("reports runway n/a when nothing was credited in the window", async () => {
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("1500")))
      mockSumNet.mockResolvedValue(0)

      const reading = await checkFygaroTreasuryFloat()

      expect(reading).toMatchObject({
        dailyBurnUsd: 0,
        runwayDays: null,
        severity: "warning",
      })
      expect(mockAlertBridge.mock.calls[0][0].detail).toContain("runway=n/a")
    })

    it("falls back to default critical thresholds when only floorUsd is configured", async () => {
      mockFygaroConfig.float = { floorUsd: 2000 }
      mockGetAccountDetails.mockResolvedValue(detailsWithBalance(usdt("499")))

      const reading = await checkFygaroTreasuryFloat()

      expect(reading).toMatchObject({ criticalFloorUsd: 500, severity: "critical" })
      expect(mockAlertBridge.mock.calls[0][0].detail).toContain(
        "https://erp.flashapp.me/app/system-accounts",
      )
    })
  })

  describe("pure helpers", () => {
    it("computeRunwayDays: unknown burn → undefined, zero burn → null, else balance/burn", () => {
      expect(computeRunwayDays(1000, undefined)).toBeUndefined()
      expect(computeRunwayDays(1000, 0)).toBeNull()
      expect(computeRunwayDays(1000, 250)).toBe(4)
    })

    it("classifyFloat: critical floor beats runway beats warning floor", () => {
      const base = { floorUsd: 2000, criticalFloorUsd: 500, criticalRunwayDays: 3 }
      expect(classifyFloat({ ...base, balanceUsd: 5000, runwayDays: 50 })).toBe("ok")
      expect(classifyFloat({ ...base, balanceUsd: 1999, runwayDays: 50 })).toBe("warning")
      expect(classifyFloat({ ...base, balanceUsd: 1999, runwayDays: undefined })).toBe(
        "warning",
      )
      expect(classifyFloat({ ...base, balanceUsd: 1999, runwayDays: null })).toBe(
        "warning",
      )
      expect(classifyFloat({ ...base, balanceUsd: 1999, runwayDays: 2.9 })).toBe(
        "critical",
      )
      expect(classifyFloat({ ...base, balanceUsd: 499, runwayDays: 400 })).toBe(
        "critical",
      )
      // Short runway escalates even above the warning floor.
      expect(classifyFloat({ ...base, balanceUsd: 3000, runwayDays: 1 })).toBe("critical")
    })
  })
})
