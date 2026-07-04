import { CashWalletCutoverRepository } from "@services/mongoose"

import {
  executeCashWalletMigrationRollbackStep,
  isRollbackableCashWalletMigrationStatus,
  requestCashWalletMigrationRollback,
} from "./rollback-worker"
import { createCashWalletMigrationRuntimeServices } from "./runtime-services"
import { runCashWalletMigrationBatch } from "./runner"
import { ROLLBACKABLE_STATUSES } from "./state-machine"
import {
  CashWalletCutoverInProgressError,
  CashWalletMigrationFailedError,
  InvalidCashWalletCutoverStateTransitionError,
} from "./errors"

type CashWalletRollbackRepository = ReturnType<typeof CashWalletCutoverRepository>

export type CashWalletRollbackRequestReport = {
  dryRun: boolean
  eligible: number
  requested: number
  skipped: Partial<Record<CashWalletMigrationStatus, number>>
  migrationIds: string[]
}

/**
 * Pull migrations into `rollback_started` (ENG-401 admin surface). Idempotent
 * and resumable: migrations already in rollback (or rolled back) count as
 * skips, never errors, so the request can be re-issued after a partial
 * failure. `dryRun` reports what would be requested without writing.
 */
export const requestPrimaryCashWalletRollback = async ({
  cutoverVersion,
  runId,
  accountId,
  reason,
  requestedBy,
  dryRun = false,
  now = new Date(),
  migrationsRepo = CashWalletCutoverRepository(),
}: {
  cutoverVersion: number
  runId: string
  /** Single-account mode when set; whole-run mode when omitted. */
  accountId?: AccountId
  reason: string
  requestedBy: string
  dryRun?: boolean
  now?: Date
  migrationsRepo?: CashWalletRollbackRepository
}): Promise<CashWalletRollbackRequestReport | ApplicationError> => {
  let candidates: CashWalletMigration[]

  if (accountId !== undefined) {
    const migration = await migrationsRepo.findMigrationByAccountId({
      accountId,
      cutoverVersion,
      runId,
    })
    if (migration instanceof Error) return migration
    if (migration === null) {
      return new CashWalletMigrationFailedError(
        `No migration found for accountId=${accountId} runId=${runId}`,
      )
    }
    candidates = [migration]
  } else {
    const migrations = await migrationsRepo.listMigrationsByStatuses({
      cutoverVersion,
      runId,
      statuses: [...ROLLBACKABLE_STATUSES, "rollback_started", "rolled_back"],
    })
    if (migrations instanceof Error) return migrations
    candidates = migrations
  }

  const report: CashWalletRollbackRequestReport = {
    dryRun,
    eligible: 0,
    requested: 0,
    skipped: {},
    migrationIds: [],
  }

  for (const migration of candidates) {
    if (!isRollbackableCashWalletMigrationStatus(migration.status)) {
      report.skipped[migration.status] = (report.skipped[migration.status] ?? 0) + 1
      continue
    }

    report.eligible += 1
    report.migrationIds.push(migration.id)
    if (dryRun) continue

    const requested = await requestCashWalletMigrationRollback({
      migration,
      migrationsRepo,
      requestedBy,
      reason,
      requestedAt: now,
    })
    if (requested instanceof Error) return requested
    report.requested += 1
  }

  return report
}

/**
 * Process one locked batch of `rollback_started` migrations. Reuses the
 * forward batch runner (locking, stale-lock recovery, failure marking) with
 * a rollback-only work list; every failure is marked
 * `requires_operator_review` — rollback errors are never retried blindly.
 */
export const runPrimaryCashWalletRollbackBatch = ({
  cutoverVersion,
  runId,
  workerId,
  limit,
  stepDelayMs,
  lockStaleBefore,
  migrationsRepo = CashWalletCutoverRepository(),
  runtimeServices = createCashWalletMigrationRuntimeServices(),
}: {
  cutoverVersion: number
  runId: string
  workerId: string
  limit?: number
  stepDelayMs?: number
  lockStaleBefore: Date
  migrationsRepo?: CashWalletRollbackRepository
  runtimeServices?: ReturnType<typeof createCashWalletMigrationRuntimeServices>
}) =>
  runCashWalletMigrationBatch({
    cutoverVersion,
    runId,
    workerId,
    limit,
    stepDelayMs,
    lockStaleBefore,
    migrationsRepo: {
      ...migrationsRepo,
      listRunnableMigrations: (args) =>
        migrationsRepo.listMigrationsByStatuses({
          ...args,
          statuses: ["rollback_started"],
        }),
      markMigrationFailed: (args) =>
        migrationsRepo.markMigrationFailed({
          ...args,
          status: "requires_operator_review",
        }),
    },
    executor: (migration) =>
      executeCashWalletMigrationRollbackStep({
        migration,
        migrationsRepo,
        services: runtimeServices,
      }),
  })

/**
 * Finalize a run-level rollback: legal only when nothing is still mid-flight
 * and nothing failed closed. Flips the cutover config to `rolled_back`;
 * `skipped_already_migrated` accounts remain on USDT by design.
 */
export const completePrimaryCashWalletRollback = async ({
  cutoverVersion,
  runId,
  actor,
  now = new Date(),
  migrationsRepo = CashWalletCutoverRepository(),
}: {
  cutoverVersion: number
  runId: string
  actor: string
  now?: Date
  migrationsRepo?: CashWalletRollbackRepository
}): Promise<CashWalletCutoverConfig | ApplicationError> => {
  const config = await migrationsRepo.getConfig()
  if (config instanceof Error) return config
  if (config.state === "rolled_back") return config
  if (config.runId !== runId || config.cutoverVersion !== cutoverVersion) {
    return new InvalidCashWalletCutoverStateTransitionError(
      `Cutover config is tracking runId=${config.runId} cutoverVersion=${config.cutoverVersion}, not the requested rollback run`,
    )
  }

  const inFlight = await migrationsRepo.countByStatus({
    cutoverVersion,
    runId,
    status: "rollback_started",
  })
  if (inFlight instanceof Error) return inFlight
  if (inFlight > 0) {
    return new CashWalletCutoverInProgressError(
      `${inFlight} migration(s) still in rollback_started`,
    )
  }

  const review = await migrationsRepo.countByStatus({
    cutoverVersion,
    runId,
    status: "requires_operator_review",
  })
  if (review instanceof Error) return review
  if (review > 0) {
    return new CashWalletMigrationFailedError(
      `${review} migration(s) require operator review before completing rollback`,
    )
  }

  return migrationsRepo.updateConfig(
    {
      state: "rolled_back",
      cutoverVersion,
      runId,
      completedAt: now,
    },
    actor,
  )
}
