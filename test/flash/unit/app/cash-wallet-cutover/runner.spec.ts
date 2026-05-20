import { CouldNotUpdateError } from "@domain/errors"

import { runCashWalletMigrationBatch } from "@app/cash-wallet-cutover/runner"

const migration = (
  status: CashWalletMigrationStatus,
  id = `${status}-migration`,
): CashWalletMigration => ({
  id,
  accountId: `${id}-account` as AccountId,
  legacyUsdWalletId: `${id}-legacy-usd-wallet` as WalletId,
  destinationUsdtWalletId: `${id}-usdt-wallet` as WalletId,
  cutoverVersion: 7,
  runId: "run-7",
  status,
  idempotencyKey: `cash-wallet-cutover:run-7:${id}-account`,
  attempts: 0,
  updatedAt: new Date("2026-05-20T00:00:00Z"),
})

describe("cash wallet migration batch runner", () => {
  it("locks each runnable migration, executes one step, and releases the lock", async () => {
    const runnable = [migration("not_started", "migration-1")]
    const locked = { ...runnable[0], lockedBy: "worker-1" }
    const completedStep = migration("started", "migration-1")
    const migrationsRepo = {
      listRunnableMigrations: jest.fn(async () => runnable),
      acquireMigrationLock: jest.fn(async () => locked),
      releaseMigrationLock: jest.fn(async () => locked),
    }
    const executor = jest.fn(async () => completedStep)

    const result = await runCashWalletMigrationBatch({
      cutoverVersion: 7,
      runId: "run-7",
      workerId: "worker-1",
      limit: 10,
      lockStaleBefore: new Date("2026-05-20T15:00:00Z"),
      migrationsRepo,
      executor,
    })

    expect(result).toEqual({ attempted: 1, advanced: 1, failed: 0, skipped: 0 })
    expect(migrationsRepo.listRunnableMigrations).toHaveBeenCalledWith({
      cutoverVersion: 7,
      runId: "run-7",
      limit: 10,
    })
    expect(migrationsRepo.acquireMigrationLock).toHaveBeenCalledWith({
      id: "migration-1",
      workerId: "worker-1",
      staleBefore: new Date("2026-05-20T15:00:00Z"),
      cutoverVersion: 7,
      runId: "run-7",
    })
    expect(executor).toHaveBeenCalledWith(locked)
    expect(migrationsRepo.releaseMigrationLock).toHaveBeenCalledWith({
      id: "migration-1",
      workerId: "worker-1",
      cutoverVersion: 7,
      runId: "run-7",
    })
  })

  it("skips migrations that cannot be locked", async () => {
    const lockError = new CouldNotUpdateError("lock unavailable")
    const migrationsRepo = {
      listRunnableMigrations: jest.fn(async () => [migration("started", "migration-1")]),
      acquireMigrationLock: jest.fn(async () => lockError),
      releaseMigrationLock: jest.fn(),
    }
    const executor = jest.fn()

    const result = await runCashWalletMigrationBatch({
      cutoverVersion: 7,
      runId: "run-7",
      workerId: "worker-1",
      limit: 10,
      lockStaleBefore: new Date("2026-05-20T15:00:00Z"),
      migrationsRepo,
      executor,
    })

    expect(result).toEqual({ attempted: 1, advanced: 0, failed: 0, skipped: 1 })
    expect(executor).not.toHaveBeenCalled()
    expect(migrationsRepo.releaseMigrationLock).not.toHaveBeenCalled()
  })

  it("releases the lock when execution fails", async () => {
    const locked = migration("balance_move_sent", "migration-1")
    const executionError = new CouldNotUpdateError("execution failed")
    const migrationsRepo = {
      listRunnableMigrations: jest.fn(async () => [locked]),
      acquireMigrationLock: jest.fn(async () => locked),
      releaseMigrationLock: jest.fn(async () => locked),
    }
    const executor = jest.fn(async () => executionError)

    const result = await runCashWalletMigrationBatch({
      cutoverVersion: 7,
      runId: "run-7",
      workerId: "worker-1",
      limit: 10,
      lockStaleBefore: new Date("2026-05-20T15:00:00Z"),
      migrationsRepo,
      executor,
    })

    expect(result).toEqual({ attempted: 1, advanced: 0, failed: 1, skipped: 0 })
    expect(migrationsRepo.releaseMigrationLock).toHaveBeenCalledWith({
      id: "migration-1",
      workerId: "worker-1",
      cutoverVersion: 7,
      runId: "run-7",
    })
  })
})
