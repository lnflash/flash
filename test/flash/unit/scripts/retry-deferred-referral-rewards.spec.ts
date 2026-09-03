/**
 * CLI arg-parsing coverage for the referral-reward backlog replay script.
 *
 * Covers the finding that --dry-run defaulted to true while the script's own
 * usage doc said "drop --dry-run to actually replay it": an operator running
 * the documented command with no flags paid nobody and had to notice a log
 * line to find out.
 *
 * yargs is globally mocked in test/flash/unit/jest.setup.ts (for config
 * loading in other suites); this file un-mocks it back to the real library
 * so buildArgs is exercised against real option-default resolution instead
 * of a stub.
 */
jest.mock("yargs", () => jest.requireActual("yargs"))

jest.mock("@services/mongodb", () => ({
  setupMongoConnection: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

jest.mock("@app/invite/retry-deferred-rewards", () => ({
  retryDeferredReferralRewards: jest.fn(),
}))

import { buildArgs } from "../../../../src/scripts/retry-deferred-referral-rewards"

describe("retry-deferred-referral-rewards buildArgs", () => {
  it("defaults dry-run to false when the flag is omitted, matching the usage doc", () => {
    const args = buildArgs(["--configPath", "dev/config/base-config.yaml"])

    expect(args["dry-run"]).toBe(false)
  })

  it("still honors --dry-run to report the backlog without paying anyone", () => {
    const args = buildArgs(["--configPath", "dev/config/base-config.yaml", "--dry-run"])

    expect(args["dry-run"]).toBe(true)
  })
})
