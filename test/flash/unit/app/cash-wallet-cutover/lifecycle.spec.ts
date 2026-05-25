jest.mock("@services/mongoose", () => ({
  CashWalletCutoverRepository: jest.fn(),
}))

import {
  completePrimaryCashWalletCutover,
  getPrimaryCashWalletCutoverStatus,
  startPrimaryCashWalletCutover,
} from "@app/cash-wallet-cutover/lifecycle"
import {
  CashWalletCutoverInProgressError,
  CashWalletMigrationFailedError,
  InvalidCashWalletCutoverStateTransitionError,
} from "@app/cash-wallet-cutover/errors"

const config = (state: CashWalletCutoverState): CashWalletCutoverConfig => ({
  state,
  cutoverVersion: 7,
  runId: "run-7",
  updatedAt: new Date("2026-05-20T00:00:00Z"),
})

const repo = ({
  currentConfig = config("pre"),
  runnable = [],
  counts = {},
}: {
  currentConfig?: CashWalletCutoverConfig
  runnable?: CashWalletMigration[]
  counts?: Partial<Record<CashWalletMigrationStatus, number>>
} = {}) => ({
  getConfig: jest.fn(async () => currentConfig),
  updateConfig: jest.fn(async (patch: Partial<CashWalletCutoverConfig>) => ({
    ...currentConfig,
    ...patch,
  })),
  listRunnableMigrations: jest.fn(async () => runnable),
  countByStatus: jest.fn(
    async ({ status }: { status: CashWalletMigrationStatus }) => counts[status] ?? 0,
  ),
})

describe("cash wallet cutover lifecycle", () => {
  const now = new Date("2026-05-20T12:00:00Z")

  it("starts a prepared cutover run", async () => {
    const migrationsRepo = repo()

    const result = await startPrimaryCashWalletCutover({
      cutoverVersion: 7,
      runId: "run-7",
      actor: "operator",
      now,
      migrationsRepo,
    })

    expect(migrationsRepo.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "in_progress",
        cutoverVersion: 7,
        runId: "run-7",
        startedAt: now,
      }),
      "operator",
    )
    expect(result).toMatchObject({ state: "in_progress", runId: "run-7" })
  })

  it("is idempotent for the active cutover run", async () => {
    const migrationsRepo = repo({ currentConfig: config("in_progress") })

    const result = await startPrimaryCashWalletCutover({
      cutoverVersion: 7,
      runId: "run-7",
      actor: "operator",
      now,
      migrationsRepo,
    })

    expect(migrationsRepo.updateConfig).not.toHaveBeenCalled()
    expect(result).toEqual(config("in_progress"))
  })

  it("rejects starting a different run while one is active", async () => {
    const migrationsRepo = repo({ currentConfig: config("in_progress") })

    const result = await startPrimaryCashWalletCutover({
      cutoverVersion: 8,
      runId: "run-8",
      actor: "operator",
      now,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(CashWalletCutoverInProgressError)
  })

  it("rejects restarting a completed cutover", async () => {
    const migrationsRepo = repo({ currentConfig: config("complete") })

    const result = await startPrimaryCashWalletCutover({
      cutoverVersion: 7,
      runId: "run-7",
      actor: "operator",
      now,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(InvalidCashWalletCutoverStateTransitionError)
  })

  it("refuses completion while runnable migrations remain", async () => {
    const migrationsRepo = repo({
      currentConfig: config("in_progress"),
      runnable: [{ id: "migration-id", status: "started" } as CashWalletMigration],
    })

    const result = await completePrimaryCashWalletCutover({
      cutoverVersion: 7,
      runId: "run-7",
      actor: "operator",
      now,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(CashWalletCutoverInProgressError)
    expect(migrationsRepo.updateConfig).not.toHaveBeenCalled()
  })

  it("refuses completion when failed migrations exist", async () => {
    const migrationsRepo = repo({
      currentConfig: config("in_progress"),
      counts: { failed: 1 },
    })

    const result = await completePrimaryCashWalletCutover({
      cutoverVersion: 7,
      runId: "run-7",
      actor: "operator",
      now,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(CashWalletMigrationFailedError)
  })

  it("marks cutover complete after all migrations are terminal-success", async () => {
    const migrationsRepo = repo({ currentConfig: config("in_progress") })

    const result = await completePrimaryCashWalletCutover({
      cutoverVersion: 7,
      runId: "run-7",
      actor: "operator",
      now,
      migrationsRepo,
    })

    expect(migrationsRepo.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "complete",
        cutoverVersion: 7,
        runId: "run-7",
        completedAt: now,
      }),
      "operator",
    )
    expect(result).toMatchObject({ state: "complete" })
  })

  it("returns non-zero migration counts for status checks", async () => {
    const migrationsRepo = repo({
      currentConfig: config("in_progress"),
      counts: { complete: 10, failed: 1 },
    })

    const result = await getPrimaryCashWalletCutoverStatus({
      cutoverVersion: 7,
      runId: "run-7",
      migrationsRepo,
    })

    expect(result).toEqual({
      config: config("in_progress"),
      countsByStatus: {
        complete: 10,
        failed: 1,
      },
    })
  })
})
