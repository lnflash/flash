import fs from "fs"
import path from "path"

import {
  FAILED_EXIT_CODE,
  OK_EXIT_CODE,
  runBridgeFundsRequestsCron,
} from "@servers/bridge-funds-requests-cron"

// ENG-889: the Bridge funds request (recall) watcher runs hourly from its own
// Job instead of once a day inside cron.ts.

const mockBridgeConfig = { enabled: true }
const mockWatch = jest.fn()
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
  ...overrides,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockBridgeConfig.enabled = true
  mockSetupMongo.mockResolvedValue({ connection: { close: mockCloseMongo } })
  mockCloseMongo.mockResolvedValue(undefined)
  mockFlushAlerts.mockResolvedValue(undefined)
  mockWatch.mockResolvedValue(summary())
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
    expect(mockSetupMongo).not.toHaveBeenCalled()
  })

  it("runs the watcher once, flushes alerts, closes mongo and exits 0", async () => {
    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
    expect(mockWatch).toHaveBeenCalledTimes(1)
    expect(mockFlushAlerts).toHaveBeenCalledTimes(1)
    expect(mockCloseMongo).toHaveBeenCalledTimes(1)
  })

  it("exits 0 when a step on one request failed, since the next run retries it", async () => {
    mockWatch.mockResolvedValue(summary({ failures: 1 }))

    expect(await runBridgeFundsRequestsCron()).toBe(OK_EXIT_CODE)
  })

  it("exits non-zero when the Bridge poll failed", async () => {
    mockWatch.mockResolvedValue(summary({ fetched: 0, newRequests: 0, pollFailed: true }))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockFlushAlerts).toHaveBeenCalledTimes(1)
    expect(mockCloseMongo).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero when the watcher throws, still flushing alerts and closing mongo", async () => {
    mockWatch.mockRejectedValue(new Error("boom"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockFlushAlerts).toHaveBeenCalledTimes(1)
    expect(mockCloseMongo).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero without watching when mongo cannot connect", async () => {
    mockSetupMongo.mockRejectedValue(new Error("no mongo"))

    expect(await runBridgeFundsRequestsCron()).toBe(FAILED_EXIT_CODE)
    expect(mockWatch).not.toHaveBeenCalled()
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
