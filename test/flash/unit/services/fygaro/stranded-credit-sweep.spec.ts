const mockFygaroConfig = {
  enabled: true,
  credit: { enabled: true } as { enabled: boolean } | undefined,
  retry: { enabled: true, lookbackDays: 7, maxPerSweep: 20 } as
    | { enabled?: boolean; lookbackDays?: number; maxPerSweep?: number }
    | undefined,
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockAlertBridge = jest.fn()
jest.mock("@services/alerts", () => ({
  alertBridge: (...args: unknown[]) => mockAlertBridge(...args),
  generateDedupKey: jest.requireActual("@services/alerts/dedup-key").generateDedupKey,
}))

const mockNotifyOpsEvent = jest.fn()
jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOpsEvent(...args),
}))

const mockListUncredited = jest.fn()
const mockReadCompletion = jest.fn()
const mockComplete = jest.fn()
jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  listUncreditedFygaroTopupsLastDays: (...args: unknown[]) => mockListUncredited(...args),
  readFygaroTopupCompletion: (...args: unknown[]) => mockReadCompletion(...args),
  completeFygaroTopup: (...args: unknown[]) => mockComplete(...args),
}))

const mockGetDiscount = jest.fn()
jest.mock("@services/frappe/fee-discounts", () => ({
  getFlashFeeDiscountPercent: (...args: unknown[]) => mockGetDiscount(...args),
}))

const mockLockIdempotencyKey = jest.fn()
jest.mock("@services/lock", () => ({
  LockService: jest.fn(() => ({
    lockIdempotencyKey: (...args: unknown[]) => mockLockIdempotencyKey(...args),
  })),
}))

const mockFindById = jest.fn()
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findById: (...args: unknown[]) => mockFindById(...args),
  }),
}))

const mockSendNotification = jest.fn()
jest.mock("@app/fygaro/send-topup-notification", () => ({
  sendFygaroTopupNotificationBestEffort: (...args: unknown[]) =>
    mockSendNotification(...args),
}))

const mockCredit = jest.fn()
jest.mock("@services/fygaro/webhook-server/credit-topup", () => {
  class FygaroCreditError extends Error {
    step: string
    constructor(step: string, message: string) {
      super(message)
      this.name = "FygaroCreditError"
      this.step = step
    }
  }
  return {
    FygaroCreditError,
    INSUFFICIENT_TREASURY_FLOAT_STEP: "insufficient-treasury-float",
    creditFygaroTopup: (...args: unknown[]) => mockCredit(...args),
  }
})

// Fee math runs for real; only the ERPNext-backed settings read is mocked.
const mockGetSettings = jest.fn()
jest.mock("@services/fygaro/webhook-server/fygaro-settings", () => ({
  getFygaroSettings: (...args: unknown[]) => mockGetSettings(...args),
}))

import { FygaroCreditError } from "@services/fygaro/webhook-server/credit-topup"
import { retryStrandedFygaroCredits } from "@services/fygaro/stranded-credit-sweep"

// Production fee model: 2.99% + $0.49 processor, 2% Flash. $70 → $66.02 net.
const settings = {
  processor: "PayPal",
  processorFeePercent: 2.99,
  processorFeeFixed: 0.49,
  flashMarginPercent: 2,
  flashMarginFixed: 0,
  autoCreditLimit: 500,
  minimumTopup: 10,
  autoCreditEnabled: true,
  dailyTopupLimits: { 1: 125, 2: 1000, 3: 2500 },
}

const row = (
  tx: string,
  amount: string | number | null,
  extra: Record<string, unknown> = {},
) => ({
  name: `row-${tx}`,
  request_id: `fygaro:${tx}`,
  account_id: `acct-${tx}`,
  amount,
  currency: "USD",
  failure_reason: null,
  source_systems_seen: "fygaro_webhook",
  raw_payload_json: JSON.stringify({ transactionId: tx, amount }),
  last_seen_at: "2026-10-03 17:11:00",
  ...extra,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.enabled = true
  mockFygaroConfig.credit = { enabled: true }
  mockFygaroConfig.retry = { enabled: true, lookbackDays: 7, maxPerSweep: 20 }
  mockGetSettings.mockResolvedValue(settings)
  mockListUncredited.mockResolvedValue([])
  mockReadCompletion.mockResolvedValue({ completed: false })
  mockComplete.mockResolvedValue(true)
  mockGetDiscount.mockResolvedValue(0)
  mockLockIdempotencyKey.mockResolvedValue(undefined)
  mockFindById.mockImplementation(async (id: string) => ({
    id,
    username: `user-${id}`,
    level: 1,
  }))
  mockCredit.mockResolvedValue({ walletId: "recipient-wallet", status: "success" })
})

describe("retryStrandedFygaroCredits", () => {
  describe("gates", () => {
    it("does nothing when fygaro is disabled", async () => {
      mockFygaroConfig.enabled = false
      const summary = await retryStrandedFygaroCredits({ availableUsd: 5000 })
      expect(summary.candidates).toBe(0)
      expect(mockGetSettings).not.toHaveBeenCalled()
      expect(mockListUncredited).not.toHaveBeenCalled()
    })

    it("does nothing when auto-credit is off at deploy level", async () => {
      mockFygaroConfig.credit = { enabled: false }
      await retryStrandedFygaroCredits({ availableUsd: 5000 })
      expect(mockListUncredited).not.toHaveBeenCalled()
    })

    it("does nothing when retry is disabled by config", async () => {
      mockFygaroConfig.retry = { enabled: false }
      await retryStrandedFygaroCredits({ availableUsd: 5000 })
      expect(mockListUncredited).not.toHaveBeenCalled()
    })

    it("does nothing when the ERPNext auto-credit toggle is off (ops kill-switch)", async () => {
      mockGetSettings.mockResolvedValue({ ...settings, autoCreditEnabled: false })
      await retryStrandedFygaroCredits({ availableUsd: 5000 })
      expect(mockListUncredited).not.toHaveBeenCalled()
      expect(mockCredit).not.toHaveBeenCalled()
    })

    it("does nothing when settings are unavailable (fail closed)", async () => {
      mockGetSettings.mockResolvedValue(undefined)
      await retryStrandedFygaroCredits({ availableUsd: 5000 })
      expect(mockListUncredited).not.toHaveBeenCalled()
    })

    it("passes lookback and cap from config to the ERPNext list", async () => {
      mockFygaroConfig.retry = { enabled: true, lookbackDays: 3, maxPerSweep: 5 }
      await retryStrandedFygaroCredits({ availableUsd: 5000 })
      expect(mockListUncredited).toHaveBeenCalledWith({ days: 3, limit: 5 })
    })

    it("uses defaults when the retry block is absent", async () => {
      mockFygaroConfig.retry = undefined
      await retryStrandedFygaroCredits({ availableUsd: 5000 })
      expect(mockListUncredited).toHaveBeenCalledWith({ days: 7, limit: 20 })
    })

    it("returns an empty summary when the list read fails, without alerting", async () => {
      mockListUncredited.mockResolvedValue(new Error("erp down"))
      const summary = await retryStrandedFygaroCredits({ availableUsd: 5000 })
      expect(summary).toMatchObject({ candidates: 0, credited: 0 })
      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockAlertBridge).not.toHaveBeenCalled()
    })
  })

  describe("happy path", () => {
    it("re-runs the SAME idempotent credit with the recomputed net and promotes the row with the full fee split", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(summary).toMatchObject({ candidates: 1, credited: 1, failed: 0 })
      expect(mockGetDiscount).toHaveBeenCalledWith({
        username: "user-acct-tx-70",
        flow: "topup",
      })
      // $70 - (2.09 + 0.49) - 1.40 = $66.02
      expect(mockCredit).toHaveBeenCalledWith({
        recipientAccountId: "acct-tx-70",
        amountCents: 6602,
        transactionId: "tx-70",
      })
      expect(mockComplete).toHaveBeenCalledWith({
        transactionId: "tx-70",
        accountId: "acct-tx-70",
        walletId: "recipient-wallet",
        amount: "70.00",
        currency: "USD",
        initialAmount: "70.00",
        processorFee: "2.58",
        flashFee: "1.40",
        finalAmount: "66.02",
        rawPayload: { transactionId: "tx-70", amount: "70.00" },
      })
    })

    it("applies the operator fee-discount whitelist exactly as the webhook does", async () => {
      mockListUncredited.mockResolvedValue([row("tx-100", 100)])
      mockGetDiscount.mockResolvedValue(100)

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      // Flash fee waived; processor fee (2.99 + 0.49 = 3.48) never discounted.
      expect(mockCredit).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 9652 }),
      )
      expect(mockComplete).toHaveBeenCalledWith(
        expect.objectContaining({ flashFee: "0.00", finalAmount: "96.52" }),
      )
    })

    it("posts an ops-feed success tagged as a sweep retry and pushes the customer once", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "deposit",
          status: "success",
          meta: expect.objectContaining({
            transactionId: "tx-70",
            net: "66.02",
            retry: "stranded-credit-sweep",
          }),
        }),
      )
      expect(mockLockIdempotencyKey).toHaveBeenCalledWith("fygaro-credit-push:tx-70")
      expect(mockSendNotification).toHaveBeenCalledWith({
        accountId: "acct-tx-70",
        outcome: "credited",
        amountCents: 6602,
        currency: "USD",
      })
    })

    it("does not re-announce to the customer when the webhook already claimed the push key", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    it("announces 'crediting' (not 'credited') when the send is pending", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockCredit.mockResolvedValue({ walletId: "recipient-wallet", status: "pending" })

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "crediting" }),
      )
    })

    it("falls back to a sweep marker payload when the row has no parsable raw payload", async () => {
      mockListUncredited.mockResolvedValue([
        row("tx-a", "20.00", { raw_payload_json: null }),
        row("tx-b", "20.00", { raw_payload_json: "{not json" }),
      ])

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockComplete.mock.calls[0][0].rawPayload).toEqual({
        source: "stranded-credit-sweep",
      })
      expect(mockComplete.mock.calls[1][0].rawPayload).toEqual({
        source: "stranded-credit-sweep",
      })
    })

    it("alerts but still counts the credit when the ERPNext promotion fails (money moved)", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockComplete.mockResolvedValue(new Error("erp write failed"))

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(summary.credited).toBe(1)
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "erpnext-audit:fygaro:tx-70",
          severity: "warning",
        }),
      )
    })
  })

  describe("never double-credit", () => {
    it("re-reads the row right before sending and skips one that is already Completed", async () => {
      mockListUncredited.mockResolvedValue([row("tx-manual", "70.00")])
      mockReadCompletion.mockResolvedValue({ completed: true, netAmountCents: 6602 })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockReadCompletion).toHaveBeenCalledWith("tx-manual")
      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockSendNotification).not.toHaveBeenCalled()
      expect(summary).toMatchObject({ candidates: 1, credited: 0, skippedCompleted: 1 })
    })

    it("checks completion AFTER the balance check, so an uncovered row is not even read", async () => {
      mockListUncredited.mockResolvedValue([row("tx-big", "400.00")])

      await retryStrandedFygaroCredits({ availableUsd: 100 })

      expect(mockReadCompletion).not.toHaveBeenCalled()
      expect(mockCredit).not.toHaveBeenCalled()
    })
  })

  describe("coverage against the available float", () => {
    it("skips a row whose net exceeds what is left, alerts warning, and still credits smaller rows behind it", async () => {
      mockListUncredited.mockResolvedValue([
        row("tx-big", "400.00"), // net 386.54 > 100
        row("tx-small", "20.00"), // net 18.51
      ])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 100 })

      expect(summary).toMatchObject({ candidates: 2, credited: 1, uncovered: 1 })
      expect(mockCredit).toHaveBeenCalledTimes(1)
      expect(mockCredit).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: "tx-small" }),
      )
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "fygaro:retry-uncovered:tx-big",
          severity: "warning",
          context: expect.objectContaining({
            transaction_id: "tx-big",
            available_usd: 100,
          }),
        }),
      )
    })

    it("decrements the remaining float as it credits, so the sum of retries never exceeds the balance", async () => {
      mockListUncredited.mockResolvedValue([
        row("tx-1", "70.00"), // 66.02
        row("tx-2", "70.00"), // 66.02 → 132.04 > 100
      ])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 100 })

      expect(summary).toMatchObject({ credited: 1, uncovered: 1 })
      expect(mockCredit).toHaveBeenCalledTimes(1)
    })
  })

  describe("failures", () => {
    it("stops the sweep and pages float-exhausted when the credit itself reports an empty treasury", async () => {
      mockListUncredited.mockResolvedValue([row("tx-1", "70.00"), row("tx-2", "20.00")])
      mockCredit.mockResolvedValue(
        new FygaroCreditError("insufficient-treasury-float", "IBEX insufficient balance"),
      )

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).toHaveBeenCalledTimes(1)
      expect(summary).toMatchObject({ credited: 0, failed: 1, stoppedOnFloat: true })
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "fygaro:float-exhausted",
          severity: "critical",
        }),
      )
      expect(mockComplete).not.toHaveBeenCalled()
    })

    it("alerts per payment on a non-float credit failure and continues to the next row", async () => {
      mockListUncredited.mockResolvedValue([row("tx-1", "70.00"), row("tx-2", "20.00")])
      mockCredit
        .mockResolvedValueOnce(new FygaroCreditError("intraledger-send", "boom"))
        .mockResolvedValueOnce({ walletId: "w", status: "success" })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(summary).toMatchObject({ credited: 1, failed: 1, stoppedOnFloat: false })
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "fygaro:retry-failed:tx-1",
          severity: "warning",
        }),
      )
    })

    it("skips (counts failed) when the account lookup fails", async () => {
      mockListUncredited.mockResolvedValue([row("tx-1", "70.00")])
      mockFindById.mockResolvedValue(new Error("not found"))

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(summary.failed).toBe(1)
    })

    it("skips rows with an unparsable or non-positive gross", async () => {
      mockListUncredited.mockResolvedValue([
        row("tx-null", null),
        row("tx-nan", "abc"),
        row("tx-zero", "0"),
      ])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(summary.failed).toBe(3)
    })

    it("leaves a row above the auto-credit limit for manual handling", async () => {
      mockListUncredited.mockResolvedValue([row("tx-big", "500.01")])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 5000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(summary).toMatchObject({ credited: 0, failed: 0, uncovered: 0 })
    })

    it("credits a row exactly at the auto-credit limit (inclusive, like the webhook gate)", async () => {
      mockListUncredited.mockResolvedValue([row("tx-edge", "500.00")])

      await retryStrandedFygaroCredits({ availableUsd: 5000 })

      expect(mockCredit).toHaveBeenCalledTimes(1)
    })

    it("skips a row whose request_id is not a fygaro key or has no account", async () => {
      mockListUncredited.mockResolvedValue([
        row("tx-1", "70.00", { request_id: "bridge:xyz" }),
        row("tx-2", "70.00", { account_id: null }),
      ])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(summary.candidates).toBe(2)
    })

    it("never throws: an unexpected error mid-sweep returns the partial summary", async () => {
      mockListUncredited.mockResolvedValue([row("tx-1", "70.00")])
      mockFindById.mockRejectedValue(new Error("mongo exploded"))

      await expect(
        retryStrandedFygaroCredits({ availableUsd: 3000 }),
      ).resolves.toMatchObject({ candidates: 1, credited: 0 })
    })
  })
})
