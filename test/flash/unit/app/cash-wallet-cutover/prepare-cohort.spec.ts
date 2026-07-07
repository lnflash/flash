const discoverMock = jest.fn()
jest.mock("@app/cash-wallet-cutover/discovery", () => ({
  discoverCashWalletCutoverAccounts: (...args: unknown[]) => discoverMock(...args),
}))

const upsertMock = jest.fn()
jest.mock("@app/cash-wallet-cutover/migration-records", () => ({
  upsertPrimaryCashWalletMigrationRecords: (args: { plans: unknown[] }) => {
    upsertMock(args)
    // echo plans back as "migrations" so prepare returns cleanly
    return Promise.resolve(args.plans)
  },
}))

import { preparePrimaryCashWalletCutover } from "@app/cash-wallet-cutover/prepare"

const legacyDefault = (id: string) => ({
  status: "legacy_default" as const,
  accountId: id as AccountId,
  legacyUsdWalletId: `${id}-usd` as WalletId,
  destinationUsdtWalletId: `${id}-usdt` as WalletId,
  previousDefaultWalletId: `${id}-usd` as WalletId,
})

const repos = {
  accountsRepo: {} as never,
  walletsRepo: {} as never,
  migrationsRepo: {} as never,
}

describe("preparePrimaryCashWalletCutover — cohort filter (phased cutover)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    discoverMock.mockResolvedValue([
      legacyDefault("acc-1"),
      legacyDefault("acc-2"),
      legacyDefault("acc-3"),
    ])
  })

  it("prepares the whole population when no cohort is given", async () => {
    const result = await preparePrimaryCashWalletCutover({
      cutoverVersion: 1,
      runId: "run-1",
      ...repos,
    })
    if (result instanceof Error) throw result
    expect(result.plannedMigrations.map((m) => m.accountId).sort()).toEqual([
      "acc-1",
      "acc-2",
      "acc-3",
    ])
    expect(result.cohortNotFound).toBeUndefined()
  })

  it("prepares only the requested cohort, leaving the rest untouched", async () => {
    const result = await preparePrimaryCashWalletCutover({
      cutoverVersion: 1,
      runId: "run-1",
      accountIds: ["acc-1", "acc-3"] as AccountId[],
      ...repos,
    })
    if (result instanceof Error) throw result
    expect(result.plannedMigrations.map((m) => m.accountId).sort()).toEqual([
      "acc-1",
      "acc-3",
    ])
    expect(result.cohortNotFound).toEqual([])
  })

  it("reports requested ids that were not found among unlocked accounts", async () => {
    const result = await preparePrimaryCashWalletCutover({
      cutoverVersion: 1,
      runId: "run-1",
      accountIds: ["acc-2", "acc-missing"] as AccountId[],
      ...repos,
    })
    if (result instanceof Error) throw result
    expect(result.plannedMigrations.map((m) => m.accountId)).toEqual(["acc-2"])
    expect(result.cohortNotFound).toEqual(["acc-missing"])
    // the preflight report is scoped to the cohort, not the full population
    expect(result.report.totalAccounts).toBe(1)
  })
})
