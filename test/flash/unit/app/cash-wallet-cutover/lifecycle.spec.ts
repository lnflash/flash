jest.mock("@services/mongoose", () => ({
  CashWalletCutoverRepository: jest.fn(),
}))

import { startPrimaryCashWalletCutover } from "@app/cash-wallet-cutover/lifecycle"
import { CashWalletCutoverPreflightError } from "@app/cash-wallet-cutover/errors"
import { UnknownRepositoryError } from "@domain/errors"

const cutoverVersion = 7
const runId = "cash-wallet-cutover-2026-06-03"
const actor = "operator@example.com"
const now = new Date("2026-06-03T18:00:00.000Z")

const preConfig = {
  state: "pre",
  cutoverVersion: 6,
  updatedAt: new Date("2026-06-03T17:00:00.000Z"),
} as CashWalletCutoverConfig

const startedConfig = {
  ...preConfig,
  state: "in_progress",
  cutoverVersion,
  runId,
  startedAt: now,
} as CashWalletCutoverConfig

const runnableMigration = {
  id: "migration-id",
  accountId: "account-id" as AccountId,
  legacyUsdWalletId: "11111111-1111-4111-8111-111111111111" as WalletId,
  destinationUsdtWalletId: "22222222-2222-4222-8222-222222222222" as WalletId,
  cutoverVersion,
  runId,
  status: "not_started",
  idempotencyKey: `${runId}:account-id`,
  attempts: 0,
  updatedAt: now,
} as CashWalletMigration

const makeRepo = ({
  config = preConfig,
  runnable = [runnableMigration],
  updateResult = startedConfig,
}: {
  config?: CashWalletCutoverConfig | RepositoryError
  runnable?: CashWalletMigration[] | RepositoryError
  updateResult?: CashWalletCutoverConfig | RepositoryError
} = {}) => ({
  getConfig: jest.fn().mockResolvedValue(config),
  updateConfig: jest.fn().mockResolvedValue(updateResult),
  listRunnableMigrations: jest.fn().mockResolvedValue(runnable),
  countByStatus: jest.fn(),
})

describe("startPrimaryCashWalletCutover", () => {
  it("rejects start when the requested run has no prepared runnable migrations", async () => {
    const repo = makeRepo({ runnable: [] })

    const result = await startPrimaryCashWalletCutover({
      cutoverVersion,
      runId,
      actor,
      now,
      migrationsRepo: repo,
    })

    expect(result).toBeInstanceOf(CashWalletCutoverPreflightError)
    expect(repo.listRunnableMigrations).toHaveBeenCalledWith({
      cutoverVersion,
      runId,
      limit: 1,
    })
    expect(repo.updateConfig).not.toHaveBeenCalled()
  })

  it("propagates prepared-run repository errors before updating config", async () => {
    const repoError = new UnknownRepositoryError("list runnable migrations failed")
    const repo = makeRepo({ runnable: repoError })

    const result = await startPrimaryCashWalletCutover({
      cutoverVersion,
      runId,
      actor,
      now,
      migrationsRepo: repo,
    })

    expect(result).toBe(repoError)
    expect(repo.updateConfig).not.toHaveBeenCalled()
  })

  it("starts when the requested run has a prepared runnable migration", async () => {
    const repo = makeRepo()

    const result = await startPrimaryCashWalletCutover({
      cutoverVersion,
      runId,
      actor,
      now,
      migrationsRepo: repo,
    })

    expect(result).toBe(startedConfig)
    expect(repo.listRunnableMigrations).toHaveBeenCalledWith({
      cutoverVersion,
      runId,
      limit: 1,
    })
    expect(repo.updateConfig).toHaveBeenCalledWith(
      {
        state: "in_progress",
        cutoverVersion,
        runId,
        startedAt: now,
        scheduledAt: undefined,
        pausedAt: undefined,
        pauseReason: undefined,
      },
      actor,
    )
  })

  it("keeps same-run in-progress start idempotent without rechecking migrations", async () => {
    const repo = makeRepo({ config: startedConfig, runnable: [] })

    const result = await startPrimaryCashWalletCutover({
      cutoverVersion,
      runId,
      actor,
      now,
      migrationsRepo: repo,
    })

    expect(result).toBe(startedConfig)
    expect(repo.listRunnableMigrations).not.toHaveBeenCalled()
    expect(repo.updateConfig).not.toHaveBeenCalled()
  })
})
