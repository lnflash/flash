const mockGetAccountTransactions = jest.fn()
const mockGetTransactionDetails = jest.fn()
const mockListRules = jest.fn()
const mockListWalletIds = jest.fn()
const mockIsInternal = jest.fn()
const mockFindWalletById = jest.fn()

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountTransactions: (...args: unknown[]) => mockGetAccountTransactions(...args),
    getTransactionDetails: (...args: unknown[]) => mockGetTransactionDetails(...args),
  },
}))

jest.mock("@services/mongoose", () => ({
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
}))

jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    listByWalletId: (...args: unknown[]) => mockListRules(...args),
    listWalletIdsWithEnabledRules: (...args: unknown[]) => mockListWalletIds(...args),
  })),
}))

jest.mock("@services/mongoose/payment-split-executions", () => ({
  PaymentSplitExecutionsRepository: jest.fn(() => mockStore.repo),
}))

jest.mock("@services/mongoose/internal-transfer-invoices", () => ({
  isInternalTransferInvoice: (...args: unknown[]) => mockIsInternal(...args),
}))

import { PaymentSplitsConfig } from "@config"
import { recordSplitExecutions } from "@app/payment-splits/record-split-executions"
import { reconcileSplits } from "@app/payment-splits/reconcile-splits"
import { splitReconcileWindowMs } from "@domain/payment-splits"
import { WalletCurrency } from "@domain/shared"

import { createFakeExecutionsStore } from "./fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const WALLET = "source-wallet"
const NOW = new Date("2026-10-11T12:00:00Z")
// The split loop reconciles every 15 minutes; its lookback is 25 minutes.
const CADENCE_MS = 15 * 60 * 1000
const WINDOW_MS = 25 * 60 * 1000
const RULE_CREATED = new Date("2026-10-11T11:00:00Z")
const HASH_1 = "1".repeat(64)
const HASH_2 = "2".repeat(64)

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

const tx = (id: string, transactionTypeId: number, createdAt: string, amount = 10) => ({
  id,
  transactionTypeId,
  createdAt,
  amount,
  accountId: WALLET,
})

const hashes: Record<string, string> = { "tx-1": HASH_1, "tx-2": HASH_2 }

const originalEnabled = PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.rows.clear()
  PaymentSplitsConfig.enabled = true
  mockListWalletIds.mockResolvedValue([WALLET])
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
})

afterAll(() => {
  PaymentSplitsConfig.enabled = originalEnabled
})

describe("reconcileSplits", () => {
  it("records a missed Lightning receive keyed by its payment hash", async () => {
    mockGetAccountTransactions.mockResolvedValue([tx("tx-1", 1, minutesAgo(5))])

    const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

    expect(summary).toEqual({
      windowMs: WINDOW_MS,
      wallets: 1,
      receivesSeen: 1,
      recorded: 1,
      errors: 0,
    })
    expect(mockGetAccountTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: WALLET }),
    )
    expect(mockGetTransactionDetails).toHaveBeenCalledWith("tx-1")
    expect([...mockStore.rows.values()]).toEqual([
      expect.objectContaining({ triggerKey: HASH_1, ruleId: "rule-1", shareCents: 100 }),
    ])
  })

  it("does not duplicate a receive the webhook already recorded", async () => {
    // The webhook path keys the same receive by the same hash.
    await recordSplitExecutions({
      walletId: WALLET,
      triggerKey: HASH_1,
      paymentHash: HASH_1,
      amount: 10,
      currency: WalletCurrency.Usdt,
      now: NOW,
    })
    mockGetAccountTransactions.mockResolvedValue([tx("tx-1", 1, minutesAgo(5))])

    const summary = await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })

    expect(summary).toMatchObject({ receivesSeen: 1, recorded: 0 })
    expect(mockStore.rows.size).toBe(1)
  })

  it("ignores a receive that settled before the rule was created", async () => {
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
      recorded: 0,
    })
    expect(mockStore.rows.size).toBe(0)
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
      recorded: 1,
    })
    expect([...mockStore.rows.values()].map((r) => r.triggerKey)).toEqual([HASH_1])
  })

  it("counts an IBEX failure for one wallet and carries on", async () => {
    mockListWalletIds.mockResolvedValue([WALLET, "other"])
    mockGetAccountTransactions
      .mockResolvedValueOnce(new Error("ibex down"))
      .mockResolvedValueOnce([tx("tx-1", 1, minutesAgo(2))])

    expect(await reconcileSplits({ cadenceMs: CADENCE_MS, now: NOW })).toMatchObject({
      wallets: 2,
      errors: 1,
      recorded: 1,
    })
  })

  it("pages through IBEX until a page reaches past the lookback", async () => {
    // A busy merchant wallet: the newest 100 transactions are all sends, and
    // the missed receive sits on the second page.
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
      recorded: 1,
      errors: 0,
    })
    expect(mockGetAccountTransactions).toHaveBeenCalledTimes(2)
    expect(mockGetAccountTransactions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ account_id: WALLET, page: 0, sort: "settledAt" }),
    )
    expect(mockGetAccountTransactions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ account_id: WALLET, page: 1 }),
    )
  })

  it("a daily cron run reaches back to a receive from the previous afternoon", async () => {
    // Cron fires at 02:00; the webhook for a 14:00 receive the day before
    // failed. The lookback derived from a 24h cadence covers it.
    const cronNow = new Date("2026-10-12T02:00:00Z")
    mockGetAccountTransactions.mockResolvedValue([tx("tx-1", 1, "2026-10-11T14:00:00Z")])

    const summary = await reconcileSplits({
      cadenceMs: 24 * 60 * 60 * 1000,
      now: cronNow,
    })

    expect(summary).toMatchObject({ receivesSeen: 1, recorded: 1 })
    expect(summary instanceof Error ? 0 : summary.windowMs).toBeGreaterThan(
      24 * 60 * 60 * 1000,
    )
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
      wallets: 0,
    })
    expect(mockListWalletIds).not.toHaveBeenCalled()
  })
})
