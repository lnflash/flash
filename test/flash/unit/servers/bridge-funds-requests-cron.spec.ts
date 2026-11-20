import fs from "fs"
import path from "path"

import {
  DEPOSIT_ORPHAN_AFTER_MS,
  FAILED_EXIT_CODE,
  OK_EXIT_CODE,
  runBridgeFundsRequestsCron,
  WITHDRAWAL_LOOKBACK_MS,
  WITHDRAWAL_STUCK_AFTER_MS,
} from "@servers/bridge-funds-requests-cron"

// ENG-889: the hourly Bridge Job runs the funds request (recall) watcher, which
// used to run once a day inside cron.ts, then the customer status watch.
// ENG-891: then the Bridge deposit to IBEX credit match and the deposit check.

const mockBridgeConfig = { enabled: true }
const mockWatch = jest.fn()
const mockWatchCustomers = jest.fn()
const mockMatchDeposits = jest.fn()
const mockReconcileDeposits = jest.fn()
const mockReconcileWithdrawals = jest.fn()
const mockSetupMongo = jest.fn()
const mockCloseMongo = jest.fn()
const mockFlushAlerts = jest.fn()

jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  get BridgeConfig() {
    return mockBridgeConfig
  },
}))

jest.mock("@services/bridge/funds-requests", () => ({
  watchBridgeFundsRequests: (...args: unknown[]) => mockWatch(...args),
}))

jest.mock("@services/bridge/customer-status-watch", () => ({
  watchBridgeCustomerStatuses: (...args: unknown[]) => mockWatchCustomers(...args),
}))

jest.mock("@app/bridge/match-ibex-deposits", () => ({
  MATCH_LOOKBACK_MS: 7 * 24 * 60 * 60 * 1000,
  matchBridgeDepositsToIbex: (...args: unknown[]) => mockMatchDeposits(...args),
}))

jest.mock("@services/bridge/reconciliation", () => ({
  reconcileBridgeAndIbexDeposits: (...args: unknown[]) => mockReconcileDeposits(...args),
  reconcileBridgeAndIbexWithdrawals: (...args: unknown[]) =>
    mockReconcileWithdrawals(...args),
}))

jest.mock("@services/mongodb", () => ({
  setupMongoConnection: (...args: unknown[]) => mockSetupMongo(...args),
}))

jest.mock("@services/alerts", () => ({
  flushAlerts: (...args: unknown[]) => mockFlushAlerts(...args),
}))

const summary = (overrides: Record<string, unknown> = {}) => ({
  fetched: 2,
  newRequests: 1,
  locked: 0,
  erpnextRecorded: 1,
  failures: 0,
  pollFailed: false,
  notPermitted: false,
  ...overrides,
})

const customerSummary = (overrides: Record<string, unknown> = {}) => ({
  fetched: 3,
  seeded: false,
  baselineRepaired: false,
  baselineRisky: {},
  changes: 0,
  alerts: 0,
  holdsPlaced: 0,
  failures: 0,
  pollFailed: false,
  ...overrides,
})

const withdrawalSummary = (overrides: Record<string, unknown> = {}) => ({
  scannedWithdrawals: 1,
  cancelledSendFailedTransfers: 0,
  finalizedCompletedTransfers: 1,
  ibexSendWithoutBridgeSettlement: 0,
  bridgeTransferWithoutIbexSend: 0,
  stuckAwaitingBridge: 0,
  failures: 0,
  ...overrides,
})

const matchSummary = (overrides: Record<string, unknown> = {}) => ({
  pending: 1,
  matched: 1,
  alreadyProcessed: 0,
  unmatched: 0,
  failures: 0,
  ...overrides,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockBridgeConfig.enabled = true
  mockSetupMongo.mockResolvedValue({ connection: { close: mockCloseMongo } })
  mockCloseMongo.mockResolvedValue(undefined)
  mockFlushAlerts.mockResolvedValue(undefined)
  mockWatch.mockResolvedValue(summary())
  mockWatchCustomers.mockResolvedValue(customerSummary())
  mockMatchDeposits.mockResolvedValue(matchSummary())
  mockReconcileDeposits.mockResolvedValue({
    scannedBridge: 1,
    scannedIbex: 1,
    bridgeWithoutIbex: 0,
    ibexWithoutBridge: 0,
  })
  mockReconcileWithdrawals.mockResolvedValue(withdrawalSummary())
})

describe("runBridgeFundsRequestsCron", () => {
  it("uses 0 for success and a non-zero failure code", () => {
    expect(OK_EXIT_CODE).toBe(0)
    expect(FAILED_EXIT_CODE).not.toBe(0)
  })

  it("does nothing and exits 0 when Bridge is disabled", async () => {
    mockBridgeConfig.enabled = false

    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
    expect(mockWatch).not.toHaveBeenCalled()
    expect(mockWatchCustomers).not.toHaveBeenCalled()
    expect(mockMatchDeposits).not.toHaveBeenCalled()
    expect(mockSetupMongo).not.toHaveBeenCalled()
  })

  it("runs every step once, flushes alerts, closes mongo and exits 0", async () => {
    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
    expect(mockWatch).toHaveBeenCalledTimes(1)
    expect(mockWatchCustomers).toHaveBeenCalledTimes(1)
    expect(mockMatchDeposits).toHaveBeenCalledTimes(1)
    expect(mockReconcileDeposits).toHaveBeenCalledTimes(1)
    expect(mockReconcileWithdrawals).toHaveBeenCalledTimes(1)
    expect(mockFlushAlerts).toHaveBeenCalledTimes(1)
    expect(mockCloseMongo).toHaveBeenCalledTimes(1)
  })

  it("exits 0 when a step on one request failed, since the next run retries it", async () => {
    mockWatch.mockResolvedValue(summary({ failures: 1 }))

    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
  })

  it("exits non-zero when the Bridge poll failed, and still runs the customer watch", async () => {
    mockWatch.mockResolvedValue(summary({ fetched: 0, newRequests: 0, pollFailed: true }))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockWatchCustomers).toHaveBeenCalledTimes(1)
    expect(mockFlushAlerts).toHaveBeenCalledTimes(1)
    expect(mockCloseMongo).toHaveBeenCalledTimes(1)
  })

  it("exits 0 when Bridge does not permit funds requests for the key", async () => {
    // Production answers 401 not_allowed on /funds_requests and Bridge will
    // not grant it: that is not a failed run.
    mockWatch.mockResolvedValue(
      summary({ fetched: 0, newRequests: 0, notPermitted: true }),
    )

    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
    expect(mockWatchCustomers).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero when the funds watcher throws, and still runs the customer watch", async () => {
    mockWatch.mockRejectedValue(new Error("boom"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockWatchCustomers).toHaveBeenCalledTimes(1)
    expect(mockFlushAlerts).toHaveBeenCalledTimes(1)
    expect(mockCloseMongo).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero when the customer watch could not run, after the funds watch ran", async () => {
    mockWatchCustomers.mockResolvedValue(customerSummary({ pollFailed: true }))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockWatch).toHaveBeenCalledTimes(1)
    expect(mockFlushAlerts).toHaveBeenCalledTimes(1)
  })

  // ENG-889: an empty or short customer list is a failed poll, so the Job fails
  // and shows in k8s rather than recording a baseline from nothing.
  it("exits non-zero when the customer watch refused an empty customer list", async () => {
    mockWatchCustomers.mockResolvedValue(
      customerSummary({ fetched: 0, pollFailed: true }),
    )

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
  })

  it("exits 0 on a run that dropped an empty baseline and seeded again", async () => {
    mockWatchCustomers.mockResolvedValue(
      customerSummary({ seeded: true, baselineRepaired: true }),
    )

    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
  })

  it("exits non-zero when the customer watch throws", async () => {
    mockWatchCustomers.mockRejectedValue(new Error("boom"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockWatch).toHaveBeenCalledTimes(1)
    expect(mockCloseMongo).toHaveBeenCalledTimes(1)
  })

  it("exits 0 when a customer change is left to retry", async () => {
    mockWatchCustomers.mockResolvedValue(customerSummary({ changes: 1, failures: 1 }))

    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
  })

  it("checks deposits over the match lookback, leaving young ones to the matcher", async () => {
    await runBridgeFundsRequestsCron()

    expect(mockReconcileDeposits).toHaveBeenCalledWith({
      windowMs: 7 * 24 * 60 * 60 * 1000,
      minAgeMs: DEPOSIT_ORPHAN_AFTER_MS,
    })
    expect(DEPOSIT_ORPHAN_AFTER_MS).toBe(6 * 60 * 60 * 1000)
    expect(mockMatchDeposits.mock.invocationCallOrder[0]).toBeLessThan(
      mockReconcileDeposits.mock.invocationCallOrder[0],
    )
  })

  it("exits 0 when a deposit is left to retry, since the next run retries it", async () => {
    mockMatchDeposits.mockResolvedValue(matchSummary({ matched: 0, failures: 1 }))

    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
    expect(mockReconcileDeposits).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero when the deposit match could not read deposits", async () => {
    mockMatchDeposits.mockResolvedValue(new Error("no mongo"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockReconcileDeposits).not.toHaveBeenCalled()
  })

  it("exits non-zero when the deposit check fails", async () => {
    mockReconcileDeposits.mockResolvedValue(new Error("boom"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
  })

  it("runs the deposit step even when both watches fail", async () => {
    mockWatch.mockRejectedValue(new Error("boom"))
    mockWatchCustomers.mockRejectedValue(new Error("boom"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockMatchDeposits).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero when the deposit match throws, after the watches ran", async () => {
    mockMatchDeposits.mockRejectedValue(new Error("boom"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockWatch).toHaveBeenCalledTimes(1)
    expect(mockWatchCustomers).toHaveBeenCalledTimes(1)
    expect(mockCloseMongo).toHaveBeenCalledTimes(1)
  })

  it("checks withdrawals over the lookback, flagging ones stuck a day", async () => {
    await runBridgeFundsRequestsCron()

    expect(mockReconcileWithdrawals).toHaveBeenCalledWith({
      windowMs: WITHDRAWAL_LOOKBACK_MS,
      stuckAfterMs: WITHDRAWAL_STUCK_AFTER_MS,
    })
    expect(WITHDRAWAL_LOOKBACK_MS).toBe(30 * 24 * 60 * 60 * 1000)
    expect(WITHDRAWAL_STUCK_AFTER_MS).toBe(24 * 60 * 60 * 1000)
  })

  it("exits 0 when one withdrawal is left to retry", async () => {
    mockReconcileWithdrawals.mockResolvedValue(withdrawalSummary({ failures: 1 }))

    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
  })

  it("exits non-zero when the withdrawal check could not run, after the other steps ran", async () => {
    mockReconcileWithdrawals.mockResolvedValue(new Error("no mongo"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockMatchDeposits).toHaveBeenCalledTimes(1)
  })

  it("runs the withdrawal check even when the deposit step throws", async () => {
    mockMatchDeposits.mockRejectedValue(new Error("boom"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockReconcileWithdrawals).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero without watching when mongo cannot connect", async () => {
    mockSetupMongo.mockRejectedValue(new Error("no mongo"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockWatch).not.toHaveBeenCalled()
    expect(mockWatchCustomers).not.toHaveBeenCalled()
  })
})

// cron.ts runs main() when imported, so check its source instead: the watcher
// must not also run from the daily Job.
describe("daily cron", () => {
  it("no longer runs the funds request watcher", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "src", "servers", "cron.ts"),
      "utf8",
    )
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n")

    expect(code).not.toContain("watchBridgeFundsRequests")
  })

  // ENG-891: it ran daily at 02:00 with a 15 minute window and saw nothing.
  it("no longer runs the Bridge deposit check", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "src", "servers", "cron.ts"),
      "utf8",
    )
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n")

    expect(code).not.toContain("reconcileBridgeAndIbexDeposits")
  })

  // ENG-891: same daily 15 minute window as the deposit check.
  it("no longer runs the Bridge withdrawal check", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "src", "servers", "cron.ts"),
      "utf8",
    )
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n")

    expect(code).not.toContain("reconcileBridgeAndIbexWithdrawals")
  })
})
