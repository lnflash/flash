type CashWalletMigrationBatchRepository = {
  listRunnableMigrations(args: {
    cutoverVersion: number
    runId: string
    limit?: number
  }): Promise<CashWalletMigration[] | RepositoryError>
  acquireMigrationLock(args: {
    id: string
    workerId: string
    staleBefore: Date
    cutoverVersion: number
    runId: string
  }): Promise<CashWalletMigration | RepositoryError>
  releaseMigrationLock(args: {
    id: string
    workerId: string
    cutoverVersion: number
    runId: string
  }): Promise<CashWalletMigration | RepositoryError>
  markMigrationFailed(args: {
    id: string
    workerId: string
    cutoverVersion: number
    runId: string
    error: Error
    status: "failed" | "requires_operator_review"
  }): Promise<CashWalletMigration | RepositoryError>
}

type CashWalletMigrationBatchExecutor = (
  migration: CashWalletMigration,
) => Promise<CashWalletMigration | ApplicationError>

type CashWalletMigrationBatchResult = {
  attempted: number
  advanced: number
  failed: number
  skipped: number
}

const AMBIGUOUS_SIDE_EFFECT_STATUSES: CashWalletMigrationStatus[] = [
  "invoice_created",
  "balance_move_sending",
  "balance_move_sent",
  "balance_move_verified",
  "fee_reimbursement_invoice_created",
  "fee_reimbursement_sending",
  "fee_reimbursed",
  "pointer_flipped",
]

const failureStatusForMigration = (
  status: CashWalletMigrationStatus,
): "failed" | "requires_operator_review" =>
  AMBIGUOUS_SIDE_EFFECT_STATUSES.includes(status) ? "requires_operator_review" : "failed"

export const runCashWalletMigrationBatch = async ({
  cutoverVersion,
  runId,
  workerId,
  limit,
  lockStaleBefore,
  migrationsRepo,
  executor,
}: {
  cutoverVersion: number
  runId: string
  workerId: string
  limit?: number
  lockStaleBefore: Date
  migrationsRepo: CashWalletMigrationBatchRepository
  executor: CashWalletMigrationBatchExecutor
}): Promise<CashWalletMigrationBatchResult | RepositoryError> => {
  const migrations = await migrationsRepo.listRunnableMigrations({
    cutoverVersion,
    runId,
    limit,
  })
  if (migrations instanceof Error) return migrations

  const result: CashWalletMigrationBatchResult = {
    attempted: 0,
    advanced: 0,
    failed: 0,
    skipped: 0,
  }

  for (const migration of migrations) {
    result.attempted += 1

    const locked = await migrationsRepo.acquireMigrationLock({
      id: migration.id,
      workerId,
      staleBefore: lockStaleBefore,
      cutoverVersion,
      runId,
    })
    if (locked instanceof Error) {
      result.skipped += 1
      continue
    }

    const step = await executor(locked)
    if (step instanceof Error) {
      result.failed += 1
      const marked = await migrationsRepo.markMigrationFailed({
        id: locked.id,
        workerId,
        cutoverVersion,
        runId,
        error: step,
        status: failureStatusForMigration(locked.status),
      })
      if (marked instanceof Error) return marked
      continue
    } else {
      result.advanced += 1
    }

    await migrationsRepo.releaseMigrationLock({
      id: locked.id,
      workerId,
      cutoverVersion,
      runId,
    })
  }

  return result
}
