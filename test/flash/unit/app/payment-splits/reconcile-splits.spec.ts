const mockGetAccountTransactions = jest.fn()
const mockGetTransactionDetails = jest.fn()
const mockGetAccountDetails = jest.fn()
const mockListRules = jest.fn()
const mockIsInternal = jest.fn()
const mockFindWalletById = jest.fn()
const mockListShadows = jest.fn()
const mockNotifyOps = jest.fn()

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountTransactions: (...args: unknown[]) => mockGetAccountTransactions(...args),
    getTransactionDetails: (...args: unknown[]) => mockGetTransactionDetails(...args),
    getAccountDetails: (...args: unknown[]) => mockGetAccountDetails(...args),
  },
}))

jest.mock("@services/logger", () => {
  const logger = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  }
  return { baseLogger: { ...logger, child: () => logger } }
})

jest.mock("@services/mongoose", () => ({
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
}))

jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    listByWalletId: (...args: unknown[]) => mockListRules(...args),
  })),
}))

jest.mock("@services/mongoose/payment-split-executions", () => ({
  PaymentSplitExecutionsRepository: jest.fn(() => mockStore.repo),
}))

jest.mock("@services/mongoose/split-receive-accounts", () => ({
  SplitReceiveAccountsRepository: jest.fn(() => ({
    listAll: (...args: unknown[]) => mockListShadows(...args),
  })),
}))

jest.mock("@services/mongoose/internal-transfer-invoices", () => ({
  isInternalTransferInvoice: (...args: unknown[]) => mockIsInternal(...args),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOps(...args),
}))

// reconcile reads the executions collection directly for open legs; model it
// with a tiny in-memory stand-in over the same store rows.
jest.mock("@services/mongoose/schema", () => ({
  PaymentSplitExecution: {
    findOne: (filter: Record<string, unknown>) => mockFindOpenLeg(filter),
  },
}))

import { PaymentSplitsConfig } from "@config"
import { buildLegs } from "@app/payment-splits/build-legs"
import { reconcileSplits } from "@app/payment-splits/reconcile-splits"
import { splitReconcileWindowMs } from "@domain/payment-splits"
import { WalletCurrency } from "@domain/shared"

import { createFakeExecutionsStore } from "./fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const WALLET = "source-wallet"
const SHADOW = "shadow-ibex-account"
const NOW = new Date("2026-10-19T12:00:00Z")
// The split loop reconciles every 15 minutes; its lookback is 25 minutes.
const CADENCE_MS = 15 * 60 * 1000
const WINDOW_MS = 25 * 60 * 1000
const RULE_CREATED = new Date("2026-10-19T11:00:00Z")
const HASH_1 = "1".repeat(64)
const HASH_2 = "2".repeat(64)

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

const tx = (id: string, transactionTypeId: number, createdAt: string, amount = 10) => ({
  id,
  transactionTypeId,
  createdAt,
  amount,
  accountId: SHADOW,
})

const hashes: Record<string, string> = { "tx-1": HASH_1, "tx-2": HASH_2 }

// Open-leg lookup over the fake store: the oldest non-terminal row for the
// shadow, matching hasOpenLegsForShadow's contract.
const mockFindOpenLeg = jest.fn((filter: Record<string, unknown>) => {
  const eq = filter.sourceIbexAccountId as string | { $eq: string }
  const shadowId = typeof eq === "string" ? eq : eq.$eq
  const open = [...mockStore.rows.values()]
    .filter(
      (r) =>
        r.sourceIbexAccountId === shadowId &&
        (r.status === "pending" || r.status === "sending"),
    )
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())[0]
  return {
    sort: () => ({
      lean: () => ({
        exec: async () => (open ? { updatedAt: open.updatedAt } : null),
      }),
    }),
  }
})

const shadowRecord = (overrides: Record<string, unknown> = {}) => ({
  walletId: WALLET,
  ibexAccountId: SHADOW,
  currency: "USDT",
  lnurlp: "lnurl1abc",
  createdAt: RULE_CREATED,
  updatedAt: RULE_CREATED,
  ...overrides,
})

// A zero balance: no residue anywhere by default.
const zeroBalance = () => ({
  balance: {
    asPaymentAmount: () => ({ amount: 0, currency: "USDT" }),
    currencyCode: "USDT",
  },
})

const originalEnabled = PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.rows.clear()
  PaymentSplitsConfig.enabled = true
  mockListShadows.mockResolvedValue([shadowRecord()])
  mockFindWalletById.mockResolvedValue({ id: WALLET, currency: WalletCurrency.Usdt })
  mockListRules.mockResolvedValue([
    {
      id: "rule-1",
      walletId: WALLET,
      destinationWalletId: "dest",
      percent: 10,
      enabled: true,
      createdAt: RULE_CREATED,
    },
  ])
  mockIsInternal.mockResolvedValue(false)
  mockGetTransactionDetails.mockImplementation(async (id: string) => ({
    id,
    amount: 10,
    invoice: { hash: hashes[id] },
  }))
  mockGetAccountDetails.mockResolvedValue(zeroBalance())
})

afterAll(() => {
  PaymentSplitsConfig.enabled = originalEnabled
})

describe("reconcileSplits (shadow-only, ENG-717)", () => {
  it("builds legs for a missed Lightning receive keyed by its payment hash", async () => {
    mockGetAccountTransactions.mockResolvedValue([tx("tx-1", 1, minutesAgo(5))])

    const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

    expect(summary).toEqual({
      windowMs: WINDOW_MS,
      shadows: 1,
      receivesSeen: 1,
      recorded: 2,
      residueAlerts: 0,
      errors: 0,
    })
    expect(mockGetAccountTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: SHADOW }),
    )
    expect(mockGetTransactionDetails).toHaveBeenCalledWith("tx-1")
    // The share leg AND the net leg (recorded counts both).
    expect([...mockStore.rows.values()].map((r) => r.legKind).sort()).toEqual([
      "net",
      "share",
    ])
    expect([...mockStore.rows.values()].every((r) => r.triggerKey === HASH_1)).toBe(true)
  })

  it("does not duplicate a receive the webhook already built", async () => {
    // The webhook path keys the same receive by the same hash.
    await buildLegs({
      walletId: WALLET,
      sourceIbexAccountId: SHADOW,
      triggerKey: HASH_1,
      paymentHash: HASH_1,
      grossAmount: 10,
      currency: WalletCurrency.Usdt,
      now: NOW,
    })
    const before = mockStore.rows.size
    mockGetAccountTransactions.mockResolvedValue([tx("tx-1", 1, minutesAgo(5))])

    const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

    expect(summary).toMatchObject({ receivesSeen: 1, recorded: 0 })
    expect(mockStore.rows.size).toBe(before)
  })

  it("ignores a receive that settled before the rule was created (net still built)", async () => {
    mockListRules.mockResolvedValue([
      {
        id: "rule-1",
        walletId: WALLET,
        destinationWalletId: "dest",
        percent: 10,
        enabled: true,
        createdAt: new Date(NOW.getTime() - 60_000),
      },
    ])
    mockGetAccountTransactions.mockResolvedValue([tx("tx-1", 1, minutesAgo(5))])

    expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
      recorded: 1,
    })
    // Only the net leg: the receive predates the rule, but the money IS in
    // the shadow and belongs to the merchant.
    expect([...mockStore.rows.values()].map((r) => r.legKind)).toEqual(["net"])
  })

  it("ignores type 9 (ETH USDT crypto receives) and every non-receive type", async () => {
    mockGetAccountTransactions.mockResolvedValue([
      tx("tx-9", 9, minutesAgo(1)),
      tx("tx-2", 2, minutesAgo(1)),
      tx("tx-3", 3, minutesAgo(1)),
    ])

    expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
      receivesSeen: 0,
      recorded: 0,
    })
    expect(mockGetTransactionDetails).not.toHaveBeenCalled()
    expect(mockStore.rows.size).toBe(0)
  })

  it("ignores receives older than the lookback window", async () => {
    mockGetAccountTransactions.mockResolvedValue([tx("tx-1", 1, minutesAgo(26))])

    expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
      receivesSeen: 0,
    })
    expect(mockGetTransactionDetails).not.toHaveBeenCalled()
  })

  it("skips a receive whose hash marks it an internal transfer", async () => {
    mockIsInternal.mockImplementation(async (hash: string) => hash === HASH_2)
    mockGetAccountTransactions.mockResolvedValue([
      tx("tx-1", 1, minutesAgo(2)),
      tx("tx-2", 1, minutesAgo(3)),
    ])

    expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
      receivesSeen: 2,
      recorded: 2,
    })
    expect(new Set([...mockStore.rows.values()].map((r) => r.triggerKey))).toEqual(
      new Set([HASH_1]),
    )
  })

  it("counts an IBEX failure for one shadow and carries on", async () => {
    const other = shadowRecord({ walletId: "other-wallet", ibexAccountId: "shadow-2" })
    mockListShadows.mockResolvedValue([shadowRecord(), other])
    mockGetAccountTransactions
      .mockResolvedValueOnce(new Error("ibex down"))
      .mockResolvedValueOnce([tx("tx-1", 1, minutesAgo(2))])

    expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
      shadows: 2,
      errors: 1,
      recorded: 2,
    })
  })

  it("pages through IBEX until a page reaches past the lookback", async () => {
    // A busy shadow: the newest 100 transactions are all sends, and the
    // missed receive sits on the second page.
    const sends = Array.from({ length: 100 }, (_, i) =>
      tx(`send-${i}`, 2, minutesAgo(1 + i * 0.1)),
    )
    mockGetAccountTransactions.mockImplementation(async ({ page }: { page: number }) => {
      if (page === 0) return sends
      if (page === 1)
        return [
          tx("tx-1", 1, minutesAgo(20)),
          ...Array.from({ length: 99 }, (_, i) => tx(`old-${i}`, 2, minutesAgo(30 + i))),
        ]
      throw new Error(`page ${page} must not be read`)
    })

    expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
      receivesSeen: 1,
      recorded: 2,
      errors: 0,
    })
    expect(mockGetAccountTransactions).toHaveBeenCalledTimes(2)
    expect(mockGetAccountTransactions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ account_id: SHADOW, page: 0, sort: "settledAt" }),
    )
    expect(mockGetAccountTransactions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ account_id: SHADOW, page: 1 }),
    )
  })

  it("a daily cron run reaches back to a receive from the previous afternoon", async () => {
    // Cron fires at 02:00; the webhook for a 14:00 receive the day before
    // failed. The lookback derived from a 24h cadence covers it.
    const cronNow = new Date("2026-10-20T02:00:00Z")
    mockGetAccountTransactions.mockResolvedValue([tx("tx-1", 1, "2026-10-19T14:00:00Z")])

    const summary = await reconcileSplits({
      cadenceMs: 24 * 60 * 60 * 1000,
      now: cronNow,
    })

    expect(summary).toMatchObject({ receivesSeen: 1 })
    expect(summary instanceof Error ? 0 : summary.windowMs).toBeGreaterThan(
      24 * 60 * 60 * 1000,
    )
  })

  describe("residue alert", () => {
    it("alerts when a shadow holds a balance with no open legs", async () => {
      mockGetAccountTransactions.mockResolvedValue([])
      mockGetAccountDetails.mockResolvedValue({
        balance: { asPaymentAmount: () => ({ amount: 2.5, currency: "USDT" }) },
      })

      const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

      expect(summary).toMatchObject({ residueAlerts: 1 })
      expect(mockNotifyOps).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "split-residue",
          status: "failed",
          amount: { value: "2.50", currency: "USD" },
          meta: expect.objectContaining({
            walletId: WALLET,
            shadowId: SHADOW,
            reason: "residual-balance-on-shadow",
          }),
        }),
      )
    })

    it("waits inside the alert window while legs are still open", async () => {
      await buildLegs({
        walletId: WALLET,
        sourceIbexAccountId: SHADOW,
        triggerKey: HASH_1,
        paymentHash: HASH_1,
        grossAmount: 10,
        currency: WalletCurrency.Usdt,
        now: new Date(NOW.getTime() - 60_000), // open 1 min ago
      })
      mockGetAccountTransactions.mockResolvedValue([])
      mockGetAccountDetails.mockResolvedValue({
        balance: { asPaymentAmount: () => ({ amount: 2.5, currency: "USDT" }) },
      })

      const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

      expect(summary).toMatchObject({ residueAlerts: 0 })
      expect(mockNotifyOps).not.toHaveBeenCalled()
    })

    it("alerts when open legs are older than the window", async () => {
      await buildLegs({
        walletId: WALLET,
        sourceIbexAccountId: SHADOW,
        triggerKey: HASH_1,
        paymentHash: HASH_1,
        grossAmount: 10,
        currency: WalletCurrency.Usdt,
        now: new Date(NOW.getTime() - 15 * 60_000), // open 15 min ago
      })
      mockGetAccountTransactions.mockResolvedValue([])
      mockGetAccountDetails.mockResolvedValue({
        balance: { asPaymentAmount: () => ({ amount: 2.5, currency: "USDT" }) },
      })

      const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

      expect(summary).toMatchObject({ residueAlerts: 1 })
    })

    it("never alerts on a zero balance, whatever the legs", async () => {
      await buildLegs({
        walletId: WALLET,
        sourceIbexAccountId: SHADOW,
        triggerKey: HASH_1,
        paymentHash: HASH_1,
        grossAmount: 10,
        currency: WalletCurrency.Usdt,
        now: new Date(NOW.getTime() - 60 * 60_000),
      })
      mockGetAccountTransactions.mockResolvedValue([])

      const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

      expect(summary).toMatchObject({ residueAlerts: 0 })
    })

    it("counts a balance read failure as an error and moves on", async () => {
      mockGetAccountTransactions.mockResolvedValue([])
      mockGetAccountDetails.mockResolvedValue(new Error("ibex down"))

      expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
        errors: 1,
        residueAlerts: 0,
      })
    })
  })

  it("scans only shadows: a wallet without one is never read", async () => {
    mockListShadows.mockResolvedValue([])
    mockGetAccountTransactions.mockResolvedValue([])

    const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

    expect(summary).toMatchObject({ shadows: 0, receivesSeen: 0 })
    expect(mockGetAccountTransactions).not.toHaveBeenCalled()
  })

  it("never looks back less than the configured cadence of either caller", () => {
    for (const cadenceMs of [
      PaymentSplitsConfig.reconcileIntervalMs,
      PaymentSplitsConfig.cronIntervalMs,
    ]) {
      expect(splitReconcileWindowMs(cadenceMs)).toBeGreaterThan(cadenceMs)
    }
    expect(PaymentSplitsConfig.cronIntervalMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })

  it("does nothing while the feature flag is off", async () => {
    PaymentSplitsConfig.enabled = false

    expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
      shadows: 0,
    })
    expect(mockListShadows).not.toHaveBeenCalled()
  })
})
