import { CashWalletCutoverRepository } from "@services/mongoose"

import {
  CashWalletCutoverInProgressError,
  CashWalletCutoverPreflightError,
  CashWalletMigrationFailedError,
  InvalidCashWalletCutoverStateTransitionError,
} from "./errors"

const migrationStatuses: CashWalletMigrationStatus[] = [
  "not_started",
  "started",
  "provisioned",
  "balance_read",
  "invoice_created",
  "balance_move_sending",
  "balance_move_sent",
  "balance_move_verified",
  "fee_reimbursement_invoice_created",
  "fee_reimbursement_sending",
  "fee_reimbursed",
  "pointer_flipped",
  "legacy_zero_verified",
  "complete",
  "failed",
  "requires_operator_review",
  "skipped_already_migrated",
  "rollback_started",
  "rolled_back",
]

type CashWalletCutoverLifecycleRepository = {
  getConfig: () => Promise<CashWalletCutoverConfig | RepositoryError>
  updateConfig: (
    patch: Partial<CashWalletCutoverConfig>,
    actor?: string,
  ) => Promise<CashWalletCutoverConfig | RepositoryError>
  listRunnableMigrations: ({
    cutoverVersion,
    runId,
    limit,
  }: {
    cutoverVersion: number
    runId: string
    limit?: number
  }) => Promise<CashWalletMigration[] | RepositoryError>
  countByStatus: ({
    cutoverVersion,
    runId,
    status,
  }: {
    cutoverVersion: number
    runId: string
    status: CashWalletMigrationStatus
  }) => Promise<number | RepositoryError>
}

export type CashWalletCutoverStatusReport = {
  config: CashWalletCutoverConfig
  countsByStatus: Partial<Record<CashWalletMigrationStatus, number>>
}

export const startPrimaryCashWalletCutover = async ({
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
  migrationsRepo?: CashWalletCutoverLifecycleRepository
}): Promise<CashWalletCutoverConfig | ApplicationError> => {
  const config = await migrationsRepo.getConfig()
  if (config instanceof Error) return config

  if (config.state === "complete") {
    return new InvalidCashWalletCutoverStateTransitionError(
      "Cash wallet cutover is already complete",
    )
  }

  if (config.state === "in_progress") {
    if (config.runId === runId && config.cutoverVersion === cutoverVersion) return config
    return new CashWalletCutoverInProgressError(
      "Cash wallet cutover is already in progress",
    )
  }

  const runnable = await migrationsRepo.listRunnableMigrations({
    cutoverVersion,
    runId,
    limit: 1,
  })
  if (runnable instanceof Error) return runnable
  if (runnable.length === 0) {
    return new CashWalletCutoverPreflightError(
      "Cash wallet cutover has no prepared migrations for this run",
    )
  }

  return migrationsRepo.updateConfig(
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
}

export const completePrimaryCashWalletCutover = async ({
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
  migrationsRepo?: CashWalletCutoverLifecycleRepository
}): Promise<CashWalletCutoverConfig | ApplicationError> => {
  const failedCount = await migrationsRepo.countByStatus({
    cutoverVersion,
    runId,
    status: "failed",
  })
  if (failedCount instanceof Error) return failedCount
  if (failedCount > 0) return new CashWalletMigrationFailedError()

  const reviewCount = await migrationsRepo.countByStatus({
    cutoverVersion,
    runId,
    status: "requires_operator_review",
  })
  if (reviewCount instanceof Error) return reviewCount
  if (reviewCount > 0) return new CashWalletMigrationFailedError()

  const runnable = await migrationsRepo.listRunnableMigrations({
    cutoverVersion,
    runId,
    limit: 1,
  })
  if (runnable instanceof Error) return runnable
  if (runnable.length > 0) return new CashWalletCutoverInProgressError()

  return migrationsRepo.updateConfig(
    {
      state: "complete",
      cutoverVersion,
      runId,
      completedAt: now,
    },
    actor,
  )
}

export const getPrimaryCashWalletCutoverStatus = async ({
  cutoverVersion,
  runId,
  migrationsRepo = CashWalletCutoverRepository(),
}: {
  cutoverVersion: number
  runId: string
  migrationsRepo?: CashWalletCutoverLifecycleRepository
}): Promise<CashWalletCutoverStatusReport | ApplicationError> => {
  const config = await migrationsRepo.getConfig()
  if (config instanceof Error) return config

  const countsByStatus: Partial<Record<CashWalletMigrationStatus, number>> = {}

  for (const status of migrationStatuses) {
    const count = await migrationsRepo.countByStatus({ cutoverVersion, runId, status })
    if (count instanceof Error) return count
    if (count > 0) countsByStatus[status] = count
  }

  return { config, countsByStatus }
}
