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

const mockFindByUsername = jest.fn()
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findByUsername: (...a: unknown[]) => mockFindByUsername(...a),
  }),
}))

jest.mock("@app/invite/retry-deferred-rewards", () => ({
  retryDeferredReferralRewards: jest.fn(),
}))

import { CouldNotFindAccountFromUsernameError } from "@domain/errors"

import {
  buildArgs,
  resolveFilters,
} from "../../../../src/scripts/retry-deferred-referral-rewards"

const CONFIG = ["--configPath", "dev/config/base-config.yaml"]
const ACCOUNT = "64b7f0c2a1b2c3d4e5f60718"
const INVITER = "64b7f0c2a1b2c3d4e5f60719"

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

describe("retry-deferred-referral-rewards filters", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("parses --account, --username and --inviter", () => {
    expect(buildArgs([...CONFIG, "--account", ACCOUNT]).account).toBe(ACCOUNT)
    expect(buildArgs([...CONFIG, "--username", "alice"]).username).toBe("alice")
    expect(buildArgs([...CONFIG, "--inviter", INVITER]).inviter).toBe(INVITER)
  })

  it("leaves every filter unset by default (whole backlog)", () => {
    const args = buildArgs(CONFIG)
    expect(args.account).toBeUndefined()
    expect(args.username).toBeUndefined()
    expect(args.inviter).toBeUndefined()
  })

  it("rejects --account together with --username", () => {
    const exit = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit")
    }) as never)
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(() =>
        buildArgs([...CONFIG, "--account", ACCOUNT, "--username", "alice"]),
      ).toThrow()
    } finally {
      exit.mockRestore()
      consoleError.mockRestore()
    }
  })

  it("resolves --username to its account id", async () => {
    mockFindByUsername.mockResolvedValue({ id: ACCOUNT })
    await expect(resolveFilters({ username: " alice " })).resolves.toEqual({
      account: ACCOUNT,
      inviter: undefined,
    })
    expect(mockFindByUsername).toHaveBeenCalledWith("alice")
  })

  it("throws (exit 1) when --username is not found", async () => {
    mockFindByUsername.mockResolvedValue(new CouldNotFindAccountFromUsernameError())
    await expect(resolveFilters({ username: "ghost" })).rejects.toThrow("ghost")
  })

  it("passes --account and --inviter through after validating their shape", async () => {
    await expect(resolveFilters({ account: ACCOUNT, inviter: INVITER })).resolves.toEqual(
      { account: ACCOUNT, inviter: INVITER },
    )
    expect(mockFindByUsername).not.toHaveBeenCalled()
  })

  it.each(["account", "inviter"] as const)(
    "throws on a malformed --%s instead of sweeping nothing silently",
    async (flag) => {
      await expect(resolveFilters({ [flag]: "alice" })).rejects.toThrow(`--${flag}`)
    },
  )

  it("returns no filters when none are given", async () => {
    await expect(resolveFilters({})).resolves.toEqual({
      account: undefined,
      inviter: undefined,
    })
  })
})
