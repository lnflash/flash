import { completePrimaryCashWalletRollback } from "@app/cash-wallet-cutover/rollback"
import { evaluateCashWalletCutoverGuard } from "@app/cash-wallet-cutover/guard"
import {
  CashWalletCutoverInProgressError,
  CashWalletMigrationFailedError,
} from "@app/cash-wallet-cutover/errors"

const NOW = new Date("2026-07-04T00:00:00.000Z")

const config = (state: CashWalletCutoverState): CashWalletCutoverConfig => ({
  state,
  cutoverVersion: 3,
  runId: "run-id",
  updatedAt: NOW,
})

const migration = (status: CashWalletMigrationStatus) =>
  ({
    id: "migration-id",
    accountId: "account-id" as AccountId,
    legacyUsdWalletId: "legacy-wallet-id" as WalletId,
    destinationUsdtWalletId: "destination-wallet-id" as WalletId,
    cutoverVersion: 3,
    runId: "run-id",
    status,
    idempotencyKey: "run-id:account-id",
    attempts: 0,
    updatedAt: NOW,
  }) as CashWalletMigration

const completionRepo = ({
  unresolved = [],
}: {
  unresolved?: CashWalletMigration[]
} = {}) =>
  ({
    getConfig: jest.fn(async () => config("in_progress")),
    listMigrationsByStatuses: jest.fn(async () => unresolved),
    updateConfig: jest.fn(async (patch: Partial<CashWalletCutoverConfig>) => ({
      ...config("in_progress"),
      ...patch,
    })),
    countByStatus: jest.fn(async () => 0),
  }) as unknown as Parameters<
    typeof completePrimaryCashWalletRollback
  >[0]["migrationsRepo"]

describe("completePrimaryCashWalletRollback", () => {
  it("refuses when any migration is still complete (single-account rollback must not flip the run)", async () => {
    const repo = completionRepo({ unresolved: [migration("complete")] })

    const result = await completePrimaryCashWalletRollback({
      cutoverVersion: 3,
      runId: "run-id",
      actor: "operator-1",
      now: NOW,
      migrationsRepo: repo,
    })

    expect(result).toBeInstanceOf(CashWalletCutoverInProgressError)
    expect((result as Error).message).toContain("'complete'")
  })

  it("refuses while any rollback is still in flight", async () => {
    const repo = completionRepo({ unresolved: [migration("rollback_started")] })

    const result = await completePrimaryCashWalletRollback({
      cutoverVersion: 3,
      runId: "run-id",
      actor: "operator-1",
      now: NOW,
      migrationsRepo: repo,
    })

    expect(result).toBeInstanceOf(CashWalletCutoverInProgressError)
  })

  it("completes when every migration is rolled_back or skipped_already_migrated", async () => {
    const repo = completionRepo({ unresolved: [] })

    const result = await completePrimaryCashWalletRollback({
      cutoverVersion: 3,
      runId: "run-id",
      actor: "operator-1",
      now: NOW,
      migrationsRepo: repo,
    })

    expect(result).toMatchObject({ state: "rolled_back", runId: "run-id" })
  })
})

describe("cutover guard rollback routing", () => {
  it("routes a rolled_back account to legacy USD even under a complete config (mode 3D)", () => {
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("complete"),
        migration: migration("rolled_back"),
      }),
    ).toEqual({ route: "legacy_usd" })
  })

  it("blocks an in-flight rollback under a complete config", () => {
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("complete"),
        migration: migration("rollback_started"),
      }),
    ).toBeInstanceOf(CashWalletCutoverInProgressError)
  })

  it("still blanket-routes untouched accounts to USDT under a complete config", () => {
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("complete"),
        migration: migration("complete"),
      }),
    ).toEqual({ route: "usdt" })
  })

  it("routes rolled_back and absent migrations to legacy USD under a rolled_back config", () => {
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("rolled_back"),
        migration: migration("rolled_back"),
      }),
    ).toEqual({ route: "legacy_usd" })
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("rolled_back"),
        migration: null,
      }),
    ).toEqual({ route: "legacy_usd" })
  })

  it("keeps skipped_already_migrated accounts on USDT under a rolled_back config", () => {
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("rolled_back"),
        migration: migration("skipped_already_migrated"),
      }),
    ).toEqual({ route: "usdt" })
  })

  it("fails closed on statuses inconsistent with a rolled_back run", () => {
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("rolled_back"),
        migration: migration("complete"),
      }),
    ).toBeInstanceOf(CashWalletMigrationFailedError)
  })
})
