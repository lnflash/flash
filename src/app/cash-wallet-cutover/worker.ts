import { assertCanTransition } from "./state-machine"
import { usdCentsToUsdtMicros } from "./amount-conversion"

type CashWalletMigrationTransitionRepository = {
  transitionMigration(args: {
    id: string
    from: CashWalletMigrationStatus
    to: CashWalletMigrationStatus
    cutoverVersion: number
    runId: string
    patch?: Partial<CashWalletMigration>
  }): Promise<CashWalletMigration | RepositoryError>
}

export const startCashWalletMigration = async ({
  migration,
  migrationsRepo,
  startedAt,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  startedAt: Date
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "started")
  if (transition instanceof Error) return transition

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "started",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: { startedAt },
  })
}

export const recordCashWalletMigrationBalance = async ({
  migration,
  migrationsRepo,
  sourceBalanceUsdCents,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  sourceBalanceUsdCents: string
}): Promise<CashWalletMigration | ApplicationError> => {
  const destinationAmountUsdtMicros = usdCentsToUsdtMicros(sourceBalanceUsdCents)
  if (destinationAmountUsdtMicros instanceof Error) return destinationAmountUsdtMicros

  const transition = assertCanTransition(migration.status, "balance_read")
  if (transition instanceof Error) return transition

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "balance_read",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      sourceBalanceUsdCents,
      destinationAmountUsdtMicros,
    },
  })
}
