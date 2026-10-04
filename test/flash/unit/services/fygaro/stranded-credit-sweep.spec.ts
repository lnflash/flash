const mockFygaroConfig = {
  enabled: true,
  credit: { enabled: true } as { enabled: boolean } | undefined,
  retry: { enabled: true, lookbackDays: 7, maxPerSweep: 20 } as
    | { enabled?: boolean; lookbackDays?: number; maxPerSweep?: number }
    | undefined,
  checkout: { ttlSeconds: 900 } as { ttlSeconds?: number } | undefined,
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
const mockSumGross = jest.fn()
const mockMarkNotCredited = jest.fn()
const mockCountAgedOut = jest.fn()
jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  listUncreditedFygaroTopupsLastDays: (...args: unknown[]) => mockListUncredited(...args),
  countAgedOutUncreditedFygaroTopups: (...args: unknown[]) => mockCountAgedOut(...args),
  readFygaroTopupCompletion: (...args: unknown[]) => mockReadCompletion(...args),
  completeFygaroTopup: (...args: unknown[]) => mockComplete(...args),
  sumFygaroTopupGrossCentsLast24h: (...args: unknown[]) => mockSumGross(...args),
  markFygaroTopupNotCredited: (...args: unknown[]) => mockMarkNotCredited(...args),
}))

// The durable credited marker lives in Redis, independent of ERPNext. Mocked
// at the client so the tests drive both the write after a credit and the read
// before a send; the marker module itself runs for real.
const mockRedisSet = jest.fn()
const mockRedisGet = jest.fn()
jest.mock("@services/redis", () => ({
  redis: {
    set: (...args: unknown[]) => mockRedisSet(...args),
    get: (...args: unknown[]) => mockRedisGet(...args),
  },
}))

const mockRecordIntentOutcome = jest.fn()
jest.mock("@services/fygaro/checkout-intent-store", () => ({
  recordIntentOutcome: (...args: unknown[]) => mockRecordIntentOutcome(...args),
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
  mockSumGross.mockResolvedValue(0)
  mockMarkNotCredited.mockResolvedValue(true)
  mockCountAgedOut.mockResolvedValue({ count: 0, requestIds: [] })
  mockRedisSet.mockResolvedValue("OK")
  mockRedisGet.mockResolvedValue(null)
  mockRecordIntentOutcome.mockResolvedValue(undefined)
  mockLockIdempotencyKey.mockResolvedValue(undefined)
  // Level 2 ($1000/day cap) so the $400 and $500 fixtures below exercise the
  // float-coverage and auto-credit-limit branches, not the daily cap. The cap
  // has its own tests under "credit gate".
  mockFindById.mockImplementation(async (id: string) => ({
    id,
    username: `user-${id}`,
    level: 2,
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
      // The daily-cap read excludes the row's own Fiat Received entry, exactly
      // as payment.ts does — without it every payment double-counts itself.
      expect(mockSumGross).toHaveBeenCalledWith({
        accountId: "acct-tx-70",
        excludeTransactionId: "tx-70",
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

    it("records the durable credited marker (30-day floor, decoupled from the lookback) BEFORE promoting the row", async () => {
      mockFygaroConfig.retry = { enabled: true, lookbackDays: 7, maxPerSweep: 20 }
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      const order: string[] = []
      mockRedisSet.mockImplementation(async () => {
        order.push("marker")
        return "OK"
      })
      mockComplete.mockImplementation(async () => {
        order.push("promote")
        return true
      })

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockRedisSet).toHaveBeenCalledWith(
        "fygaro:sweep-credited:tx-70",
        "6602",
        "EX",
        30 * 24 * 60 * 60,
      )
      expect(order).toEqual(["marker", "promote"])
    })

    it("escalates to CRITICAL (money moved, promote by hand) when the ERPNext promotion fails, and still counts the credit", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockComplete.mockResolvedValue(new Error("erp write failed"))

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(summary.credited).toBe(1)
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "erpnext-audit:fygaro:tx-70",
          severity: "critical",
          title: expect.stringContaining("promote the row by hand"),
        }),
      )
      // The marker was written before the promotion, so the next tick skips.
      expect(mockRedisSet).toHaveBeenCalledWith(
        "fygaro:sweep-credited:tx-70",
        "6602",
        "EX",
        expect.any(Number),
      )
    })

    it("promotion fails on tick 1 → tick 2 does NOT re-send, re-post to ops, or re-push the customer", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockComplete.mockResolvedValue(new Error("erp write failed"))
      // Real Redis semantics for the marker: tick 1 writes it, tick 2 reads it.
      const store = new Map<string, string>()
      mockRedisSet.mockImplementation(async (key: string, value: string) => {
        store.set(key, value)
        return "OK"
      })
      mockRedisGet.mockImplementation(async (key: string) => store.get(key) ?? null)

      const tick1 = await retryStrandedFygaroCredits({ availableUsd: 3000 })
      expect(tick1).toMatchObject({ credited: 1 })
      expect(mockCredit).toHaveBeenCalledTimes(1)
      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(mockSendNotification).toHaveBeenCalledTimes(1)

      // Row still lists as stranded (Fiat Received, no failure_reason), and the
      // webhook's push timelock has long expired.
      mockLockIdempotencyKey.mockResolvedValue(undefined)
      const tick2 = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(tick2).toMatchObject({ candidates: 1, credited: 0, skippedCompleted: 1 })
      expect(mockCredit).toHaveBeenCalledTimes(1)
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(mockSendNotification).toHaveBeenCalledTimes(1)
    })

    it("does not send when the credited marker cannot be read (unknown is a stop, not a clean slate)", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockRedisGet.mockRejectedValue(new Error("redis down"))

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(summary).toMatchObject({ credited: 0, failed: 1 })
    })

    it("stamps the checkout intent credited when the stored payload carries an intent id", async () => {
      mockListUncredited.mockResolvedValue([
        row("tx-70", "70.00", {
          raw_payload_json: JSON.stringify({
            transactionId: "tx-70",
            amount: "70.00",
            customReference: "user-acct-tx-70|intent-abc",
          }),
        }),
      ])

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockRecordIntentOutcome).toHaveBeenCalledWith({
        intentId: "intent-abc",
        outcome: expect.objectContaining({
          state: "credited",
          netAmountCents: 6602,
          transactionId: "tx-70",
        }),
        ttlSeconds: 900,
      })
    })

    it("does not touch the intent store when the payload is a legacy bare-username reference or unparsable", async () => {
      mockListUncredited.mockResolvedValue([
        row("tx-a", "20.00", {
          raw_payload_json: JSON.stringify({ customReference: "user-acct-tx-a" }),
        }),
        row("tx-b", "20.00", { raw_payload_json: "{not json" }),
        row("tx-c", "20.00", { raw_payload_json: null }),
      ])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(summary.credited).toBe(3)
      expect(mockRecordIntentOutcome).not.toHaveBeenCalled()
    })
  })

  describe("credit gate (re-run exactly as the webhook runs it)", () => {
    it("refuses a row that now exceeds the daily cap: stamps the reason, alerts, does not credit, counts leftForManual", async () => {
      // Level 1, $125/day. $100 already charged in the window, this row is $100.
      mockFindById.mockImplementation(async (id: string) => ({
        id,
        username: `user-${id}`,
        level: 1,
      }))
      mockSumGross.mockResolvedValue(10000)
      mockListUncredited.mockResolvedValue([row("tx-cap", "100.00")])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockSendNotification).not.toHaveBeenCalled()
      expect(mockMarkNotCredited).toHaveBeenCalledWith({
        transactionId: "tx-cap",
        accountId: "acct-tx-cap",
        amount: "100.00",
        currency: "USD",
        reason: "daily-limit-exceeded",
        rawPayload: { transactionId: "tx-cap", amount: "100.00" },
      })
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "fygaro:not-credited:tx-cap",
          severity: "warning",
          context: expect.objectContaining({ reason: "daily-limit-exceeded" }),
        }),
      )
      expect(summary).toMatchObject({
        candidates: 1,
        credited: 0,
        failed: 0,
        leftForManual: 1,
      })
    })

    it("credits a row landing exactly ON the daily cap (inclusive, like the webhook)", async () => {
      mockFindById.mockImplementation(async (id: string) => ({
        id,
        username: `user-${id}`,
        level: 1,
      }))
      mockSumGross.mockResolvedValue(2500) // $25 prior + $100 = $125 cap
      mockListUncredited.mockResolvedValue([row("tx-edge", "100.00")])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).toHaveBeenCalledTimes(1)
      expect(summary.credited).toBe(1)
    })

    it("defers (does not stamp) when the trailing-24h history read fails — transient, retried next sweep", async () => {
      mockSumGross.mockResolvedValue(new Error("erp blip"))
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockMarkNotCredited).not.toHaveBeenCalled()
      expect(mockAlertBridge).not.toHaveBeenCalled()
      expect(summary).toMatchObject({ credited: 0, failed: 1, leftForManual: 0 })
    })

    it("refuses a level with no configured daily limit (fail closed to manual)", async () => {
      mockFindById.mockImplementation(async (id: string) => ({
        id,
        username: `user-${id}`,
        level: 0,
      }))
      mockListUncredited.mockResolvedValue([row("tx-l0", "70.00")])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockMarkNotCredited).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "no-daily-limit-for-level" }),
      )
      expect(summary.leftForManual).toBe(1)
    })

    it("pages CRITICAL when a refusal cannot be stamped on the audit row", async () => {
      mockSumGross.mockResolvedValue(100000)
      mockMarkNotCredited.mockResolvedValue(new Error("erp write failed"))
      mockListUncredited.mockResolvedValue([row("tx-cap", "100.00")])

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "fygaro:refusal-not-stamped:tx-cap",
          severity: "critical",
        }),
      )
    })

    it("sends the gate's own fee figure, so the fee math has one owner", async () => {
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockGetDiscount.mockResolvedValue(50)

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      // $70 - 2.58 processor - (1.40 * 0.5 = 0.70) flash = $66.72
      expect(mockCredit).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 6672 }),
      )
      expect(mockComplete).toHaveBeenCalledWith(
        expect.objectContaining({ flashFee: "0.70", finalAmount: "66.72" }),
      )
    })
  })

  describe("never double-credit", () => {
    it("re-reads the row before any gate or send and skips one that is already Completed", async () => {
      mockListUncredited.mockResolvedValue([row("tx-manual", "70.00")])
      mockReadCompletion.mockResolvedValue({ completed: true, netAmountCents: 6602 })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockReadCompletion).toHaveBeenCalledWith("tx-manual")
      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockSendNotification).not.toHaveBeenCalled()
      expect(summary).toMatchObject({ candidates: 1, credited: 0, skippedCompleted: 1 })
    })

    it("checks completion BEFORE the balance check, so an uncovered row is still read", async () => {
      mockListUncredited.mockResolvedValue([row("tx-big", "400.00")])

      await retryStrandedFygaroCredits({ availableUsd: 100 })

      expect(mockReadCompletion).toHaveBeenCalledWith("tx-big")
      expect(mockRedisGet).toHaveBeenCalledWith("fygaro:sweep-credited:tx-big")
      expect(mockCredit).not.toHaveBeenCalled()
    })

    it("does not report a Completed row as uncovered, however low the float", async () => {
      mockListUncredited.mockResolvedValue([row("tx-big", "400.00")])
      mockReadCompletion.mockResolvedValue({ completed: true, netAmountCents: 38654 })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 100 })

      expect(summary).toMatchObject({ skippedCompleted: 1, uncovered: 0 })
      expect(mockAlertBridge).not.toHaveBeenCalledWith(
        expect.objectContaining({ dedupKey: "fygaro:retry-uncovered:tx-big" }),
      )
    })

    it("does not re-raise 'uncovered' every tick for a marker-credited row", async () => {
      mockListUncredited.mockResolvedValue([row("tx-big", "400.00")])
      mockRedisGet.mockResolvedValue("38654")

      const summary = await retryStrandedFygaroCredits({ availableUsd: 100 })

      expect(summary).toMatchObject({ skippedCompleted: 1, uncovered: 0, credited: 0 })
      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockAlertBridge).not.toHaveBeenCalledWith(
        expect.objectContaining({ dedupKey: "fygaro:retry-uncovered:tx-big" }),
      )
    })

    it("never re-gates a marker-credited row: a gate that would now refuse does NOT stamp or alert not-credited", async () => {
      // Level 1 ($125/day) with $100 already in the window: the gate would
      // refuse this $100 row with daily-limit-exceeded. But the customer was
      // already paid — stamping would drop the row out of the allowance sum
      // and tell ops the wallet is wrong.
      mockFindById.mockImplementation(async (id: string) => ({
        id,
        username: `user-${id}`,
        level: 1,
      }))
      mockSumGross.mockResolvedValue(10000)
      mockListUncredited.mockResolvedValue([row("tx-paid", "100.00")])
      mockRedisGet.mockResolvedValue("9452")

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockMarkNotCredited).not.toHaveBeenCalled()
      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockSumGross).not.toHaveBeenCalled()
      expect(mockAlertBridge).not.toHaveBeenCalledWith(
        expect.objectContaining({ dedupKey: "fygaro:not-credited:tx-paid" }),
      )
      expect(summary).toMatchObject({
        skippedCompleted: 1,
        leftForManual: 0,
        credited: 0,
      })
    })

    it("never re-gates a Completed row either: no stamp, no not-credited alert", async () => {
      mockFindById.mockImplementation(async (id: string) => ({
        id,
        username: `user-${id}`,
        level: 1,
      }))
      mockSumGross.mockResolvedValue(10000)
      mockListUncredited.mockResolvedValue([row("tx-done", "100.00")])
      mockReadCompletion.mockResolvedValue({ completed: true, netAmountCents: 9452 })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockMarkNotCredited).not.toHaveBeenCalled()
      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockAlertBridge).not.toHaveBeenCalledWith(
        expect.objectContaining({ dedupKey: "fygaro:not-credited:tx-done" }),
      )
      expect(summary).toMatchObject({ skippedCompleted: 1, leftForManual: 0 })
    })

    it("pages CRITICAL (promote by hand) for a marker-credited row that is still not Completed, without sending", async () => {
      // The webhook's shape: it credited, wrote the marker, and the promotion
      // failed. Fygaro never retries a 200 and this sweep refuses to re-send,
      // so the sweep is the only thing left that can page a human.
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockReadCompletion.mockResolvedValue({ completed: false })
      mockRedisGet.mockResolvedValue("6602")

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockSendNotification).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "erpnext-audit:fygaro:tx-70",
          source: "erpnext-audit",
          severity: "critical",
          title: expect.stringContaining("promote the row by hand"),
          context: {
            transaction_id: "tx-70",
            account_id: "acct-tx-70",
            net_usd: 66.02,
          },
        }),
      )
      expect(summary).toMatchObject({ candidates: 1, credited: 0, skippedCompleted: 1 })
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
          detail: expect.stringContaining("available above reserve=$100.00"),
          context: expect.objectContaining({
            transaction_id: "tx-big",
            available_usd: 100,
          }),
        }),
      )
    })

    it("float $600 with a $500 critical floor leaves $100 to spend: one $280 row is uncovered, NOT credited", async () => {
      // The treasury loop hands the sweep balance - criticalFloor (100), not
      // the balance (600). Crediting this row would take the float to $331,
      // under the floor the loop just gated on, and the next live top-up
      // would fail with insufficient-treasury-float.
      mockListUncredited.mockResolvedValue([row("tx-280", "280.00")]) // net ≈ 265.6

      const summary = await retryStrandedFygaroCredits({ availableUsd: 600 - 500 })

      expect(summary).toMatchObject({ candidates: 1, credited: 0, uncovered: 1 })
      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "fygaro:retry-uncovered:tx-280",
          severity: "warning",
          context: expect.objectContaining({ available_usd: 100 }),
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

  describe("aged-out stranded rows (never silent)", () => {
    it("pages CRITICAL once with the count and oldest request_id when stranded rows have fallen out of the lookback — even with no candidates in window", async () => {
      mockListUncredited.mockResolvedValue([])
      mockCountAgedOut.mockResolvedValue({
        count: 3,
        oldestRequestId: "fygaro:tx-old",
        oldestLastSeenAt: "2026-09-20 09:00:00",
        requestIds: ["fygaro:tx-old", "fygaro:tx-mid", "fygaro:tx-new"],
      })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCountAgedOut).toHaveBeenCalledWith({ days: 7 })
      expect(summary).toMatchObject({ candidates: 0, agedOut: 3 })
      // Every aged-out id was checked against the credited marker before the
      // page told anyone what to do with it.
      expect(mockRedisGet).toHaveBeenCalledWith("fygaro:sweep-credited:tx-old")
      expect(mockRedisGet).toHaveBeenCalledWith("fygaro:sweep-credited:tx-mid")
      expect(mockRedisGet).toHaveBeenCalledWith("fygaro:sweep-credited:tx-new")
      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "fygaro:retry-aged-out",
          severity: "critical",
          title:
            "Fygaro stranded-credit sweep aged out 3 stranded top-ups — 3 uncredited: credit by hand",
          detail: expect.stringContaining("oldest=fygaro:tx-old"),
          context: expect.objectContaining({
            aged_out: 3,
            lookback_days: 7,
            oldest_request_id: "fygaro:tx-old",
            oldest_last_seen_at: "2026-09-20 09:00:00",
            uncredited_count: 3,
            credited_not_completed_count: 0,
            unverified_count: 0,
            uncredited_request_ids: "fygaro:tx-old,fygaro:tx-mid,fygaro:tx-new",
          }),
        }),
      )
    })

    it("an aged-out row with a credited marker is paged as PROMOTE by hand, never credit — the day-8 double-pay trap", async () => {
      // Day 1: the sweep credited tx-paid, wrote the marker, and the ERPNext
      // promotion failed. The row still reads Fiat Received / no
      // failure_reason. Day 8: it leaves the window, the per-row "promote by
      // hand" critical stops firing, and the aged-out page is the only thing
      // naming it. If that page says "credit by hand", ops pays twice.
      mockListUncredited.mockResolvedValue([])
      mockCountAgedOut.mockResolvedValue({
        count: 2,
        oldestRequestId: "fygaro:tx-paid",
        oldestLastSeenAt: "2026-09-20 09:00:00",
        requestIds: ["fygaro:tx-paid", "fygaro:tx-unpaid"],
      })
      mockRedisGet.mockImplementation(async (key: string) =>
        key === "fygaro:sweep-credited:tx-paid" ? "6602" : null,
      )

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      const alert = mockAlertBridge.mock.calls[0][0]
      expect(alert.dedupKey).toBe("fygaro:retry-aged-out")
      expect(alert.severity).toBe("critical")
      expect(alert.title).toBe(
        "Fygaro stranded-credit sweep aged out 2 stranded top-ups — 1 uncredited: credit by hand; 1 already credited but not Completed: promote by hand, do NOT re-credit",
      )
      expect(alert.detail).toContain("do NOT re-credit")
      expect(alert.context).toMatchObject({
        uncredited_count: 1,
        credited_not_completed_count: 1,
        unverified_count: 0,
        uncredited_request_ids: "fygaro:tx-unpaid",
        credited_request_ids: "fygaro:tx-paid",
      })
    })

    it("pages ONLY promote-by-hand (no 'credit by hand' anywhere) when every aged-out row carries a credited marker", async () => {
      mockCountAgedOut.mockResolvedValue({
        count: 1,
        oldestRequestId: "fygaro:tx-paid",
        requestIds: ["fygaro:tx-paid"],
      })
      mockRedisGet.mockResolvedValue("6602")

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      const alert = mockAlertBridge.mock.calls[0][0]
      expect(alert.title).toBe(
        "Fygaro stranded-credit sweep aged out 1 stranded top-up — 1 already credited but not Completed: promote by hand, do NOT re-credit",
      )
      expect(alert.title).not.toContain("credit by hand")
      expect(alert.context).toMatchObject({
        uncredited_count: 0,
        credited_not_completed_count: 1,
        credited_request_ids: "fygaro:tx-paid",
      })
    })

    it("reports an id whose marker cannot be read as UNVERIFIED (check before crediting), not as uncredited", async () => {
      mockCountAgedOut.mockResolvedValue({
        count: 1,
        oldestRequestId: "fygaro:tx-x",
        requestIds: ["fygaro:tx-x"],
      })
      mockRedisGet.mockRejectedValue(new Error("redis down"))

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      const alert = mockAlertBridge.mock.calls[0][0]
      expect(alert.title).toBe(
        "Fygaro stranded-credit sweep aged out 1 stranded top-up — 1 unverified: check the credited marker / wallet history before crediting",
      )
      expect(alert.context).toMatchObject({
        uncredited_count: 0,
        unverified_count: 1,
        unverified_request_ids: "fygaro:tx-x",
      })
    })

    it("counts rows beyond the returned id cap as unverified rather than 'credit by hand'", async () => {
      mockCountAgedOut.mockResolvedValue({
        count: 52,
        oldestRequestId: "fygaro:tx-0",
        requestIds: ["fygaro:tx-0", "fygaro:tx-1"],
      })

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      const alert = mockAlertBridge.mock.calls[0][0]
      expect(alert.title).toBe(
        "Fygaro stranded-credit sweep aged out 52 stranded top-ups — 2 uncredited: credit by hand; 50 unverified: check the credited marker / wallet history before crediting",
      )
      expect(alert.context).toMatchObject({
        aged_out: 52,
        uncredited_count: 2,
        unverified_count: 50,
      })
    })

    it("counts aged-out rows AFTER a sweep with candidates too, using the configured lookback", async () => {
      mockFygaroConfig.retry = { enabled: true, lookbackDays: 14, maxPerSweep: 20 }
      mockListUncredited.mockResolvedValue([row("tx-70", "70.00")])
      mockCountAgedOut.mockResolvedValue({
        count: 1,
        oldestRequestId: "fygaro:tx-old",
        requestIds: ["fygaro:tx-old"],
      })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCountAgedOut).toHaveBeenCalledWith({ days: 14 })
      expect(summary).toMatchObject({ credited: 1, agedOut: 1 })
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: "fygaro:retry-aged-out",
          title:
            "Fygaro stranded-credit sweep aged out 1 stranded top-up — 1 uncredited: credit by hand",
          detail: expect.stringContaining("14-day lookback"),
        }),
      )
    })

    it("does not page when nothing has aged out", async () => {
      mockCountAgedOut.mockResolvedValue({ count: 0 })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(summary.agedOut).toBe(0)
      expect(mockAlertBridge).not.toHaveBeenCalledWith(
        expect.objectContaining({ dedupKey: "fygaro:retry-aged-out" }),
      )
    })

    it("still pages aged-out rows when the in-window sweep stopped on an exhausted float", async () => {
      mockListUncredited.mockResolvedValue([row("tx-1", "70.00")])
      mockCredit.mockResolvedValue(
        new FygaroCreditError("insufficient-treasury-float", "IBEX insufficient balance"),
      )
      mockCountAgedOut.mockResolvedValue({
        count: 2,
        oldestRequestId: "fygaro:tx-old",
        requestIds: ["fygaro:tx-old", "fygaro:tx-old2"],
      })

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(summary).toMatchObject({ stoppedOnFloat: true, agedOut: 2 })
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ dedupKey: "fygaro:retry-aged-out" }),
      )
    })

    it("warns (does not page, does not throw) when the aged-out count read fails", async () => {
      mockCountAgedOut.mockResolvedValue(new Error("erp down"))

      const summary = await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(summary.agedOut).toBe(0)
      expect(mockAlertBridge).not.toHaveBeenCalledWith(
        expect.objectContaining({ dedupKey: "fygaro:retry-aged-out" }),
      )
    })

    it("does not count aged-out rows when the sweep itself is gated off (kill-switch)", async () => {
      mockGetSettings.mockResolvedValue({ ...settings, autoCreditEnabled: false })

      await retryStrandedFygaroCredits({ availableUsd: 3000 })

      expect(mockCountAgedOut).not.toHaveBeenCalled()
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

    it("leaves a row above the auto-credit limit for manual handling: stamped over-limit, counted leftForManual", async () => {
      mockListUncredited.mockResolvedValue([row("tx-big", "500.01")])

      const summary = await retryStrandedFygaroCredits({ availableUsd: 5000 })

      expect(mockCredit).not.toHaveBeenCalled()
      expect(mockMarkNotCredited).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: "tx-big", reason: "over-limit" }),
      )
      expect(summary).toMatchObject({
        credited: 0,
        failed: 0,
        uncovered: 0,
        leftForManual: 1,
      })
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
      expect(mockMarkNotCredited).not.toHaveBeenCalled()
      expect(summary).toMatchObject({ candidates: 2, leftForManual: 2 })
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
