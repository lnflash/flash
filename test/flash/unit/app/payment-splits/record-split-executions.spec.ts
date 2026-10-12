const mockListRules = jest.fn()
const mockIsInternal = jest.fn()

jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    listByWalletId: (...args: unknown[]) => mockListRules(...args),
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
import { WalletCurrency } from "@domain/shared"

import { createFakeExecutionsStore } from "./fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const WALLET = "source-wallet"
const HASH = "a".repeat(64)
const RULE_CREATED = new Date("2026-10-01T00:00:00Z")

const rules = [
  {
    id: "rule-1",
    walletId: WALLET,
    destinationWalletId: "dest-1",
    percent: 10,
    enabled: true,
    createdAt: RULE_CREATED,
  },
  {
    id: "rule-2",
    walletId: WALLET,
    destinationWalletId: "dest-2",
    percent: 25,
    enabled: true,
    createdAt: RULE_CREATED,
  },
]

const record = (overrides: Record<string, unknown> = {}) =>
  recordSplitExecutions({
    walletId: WALLET,
    triggerKey: HASH,
    paymentHash: HASH,
    amount: 10,
    currency: WalletCurrency.Usdt,
    ...overrides,
  })

const originalEnabled = PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.rows.clear()
  PaymentSplitsConfig.enabled = true
  mockListRules.mockResolvedValue(rules)
  mockIsInternal.mockResolvedValue(false)
})

afterAll(() => {
  PaymentSplitsConfig.enabled = originalEnabled
})

describe("recordSplitExecutions", () => {
  it("records one pending execution per enabled rule with the floored share", async () => {
    const result = await record()

    expect(result).toEqual({ recorded: 2, duplicates: 0, skippedMin: 0 })
    expect(mockListRules).toHaveBeenCalledWith(WALLET, { enabledOnly: true })
    const rows = [...mockStore.rows.values()]
    expect(rows).toEqual([
      expect.objectContaining({
        triggerKey: HASH,
        ruleId: "rule-1",
        destinationWalletId: "dest-1",
        shareCents: 100,
        triggerAmountMinor: "10000000",
        status: "pending",
      }),
      expect.objectContaining({ ruleId: "rule-2", shareCents: 250, status: "pending" }),
    ])
  })

  it("holds a freshly recorded row back from the executor for claimGraceMs", async () => {
    // An LNURL send from another Flash user is marked internal only after
    // payToLnurl returns. A row claimable at once could be paid by a loop tick
    // landing before that marker is written (ENG-653 decision 1).
    const now = new Date("2026-10-11T12:00:00Z")
    const grace = PaymentSplitsConfig.claimGraceMs
    expect(grace).toBeGreaterThanOrEqual(60_000)

    await record({ now })

    expect(await mockStore.repo.claimNextDue(now)).toBeNull()
    expect(
      await mockStore.repo.claimNextDue(new Date(now.getTime() + grace - 1)),
    ).toBeNull()
    const claimed = await mockStore.repo.claimNextDue(new Date(now.getTime() + grace))
    expect(claimed).toMatchObject({ status: "sending", triggerKey: HASH })
  })

  it("records one row per rule however many times the same trigger is replayed", async () => {
    for (let i = 0; i < 5; i++) await record()

    expect(mockStore.rows.size).toBe(2)
    expect(await record()).toEqual({ recorded: 0, duplicates: 2, skippedMin: 0 })
  })

  it("records nothing for a hash Flash minted for its own transfer", async () => {
    mockIsInternal.mockResolvedValue(true)

    expect(await record()).toEqual({ recorded: 0, duplicates: 0, skippedMin: 0 })
    expect(mockIsInternal).toHaveBeenCalledWith(HASH)
    expect(mockStore.rows.size).toBe(0)
  })

  it("records nothing while the feature flag is off", async () => {
    PaymentSplitsConfig.enabled = false

    expect(await record()).toEqual({ recorded: 0, duplicates: 0, skippedMin: 0 })
    expect(mockListRules).not.toHaveBeenCalled()
    expect(mockStore.rows.size).toBe(0)
  })

  it("records nothing for a BTC wallet", async () => {
    expect(await record({ currency: WalletCurrency.Btc })).toEqual({
      recorded: 0,
      duplicates: 0,
      skippedMin: 0,
    })
    expect(mockStore.rows.size).toBe(0)
  })

  it("records a below-minimum share as skipped_min so it is never sent", async () => {
    const result = await record({ amount: 0.03, currency: WalletCurrency.Usd })

    expect(result).toEqual({ recorded: 0, duplicates: 0, skippedMin: 2 })
    expect([...mockStore.rows.values()].map((r) => r.status)).toEqual([
      "skipped_min",
      "skipped_min",
    ])
  })

  it("ignores a receive that settled before the rule existed", async () => {
    const result = await record({ receivedAt: new Date("2026-09-30T23:59:59Z") })

    expect(result).toEqual({ recorded: 0, duplicates: 0, skippedMin: 0 })
  })

  it("returns repository errors instead of throwing", async () => {
    const err = new Error("mongo down")
    mockIsInternal.mockResolvedValue(err)
    expect(await record()).toBe(err)
  })
})
