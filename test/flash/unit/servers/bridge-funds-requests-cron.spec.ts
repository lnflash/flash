import fs from "fs"
import path from "path"

import {
  FAILED_EXIT_CODE,
  OK_EXIT_CODE,
  runBridgeFundsRequestsCron,
} from "@servers/bridge-funds-requests-cron"

// ENG-889: the hourly Bridge Job runs the funds request (recall) watcher, which
// used to run once a day inside cron.ts, then the customer status watch.

const mockBridgeConfig = { enabled: true }
const mockWatch = jest.fn()
const mockWatchCustomers = jest.fn()
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

beforeEach(() => {
  jest.clearAllMocks()
  mockBridgeConfig.enabled = true
  mockSetupMongo.mockResolvedValue({ connection: { close: mockCloseMongo } })
  mockCloseMongo.mockResolvedValue(undefined)
  mockFlushAlerts.mockResolvedValue(undefined)
  mockWatch.mockResolvedValue(summary())
  mockWatchCustomers.mockResolvedValue(customerSummary())
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
    expect(mockSetupMongo).not.toHaveBeenCalled()
  })

  it("runs both watches once, flushes alerts, closes mongo and exits 0", async () => {
    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
    expect(mockWatch).toHaveBeenCalledTimes(1)
    expect(mockWatchCustomers).toHaveBeenCalledTimes(1)
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
})
