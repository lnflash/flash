type RunnableCashWalletMigrationStatus = Exclude<
  CashWalletMigrationStatus,
  | "complete"
  | "failed"
  | "requires_operator_review"
  | "skipped_already_migrated"
  | "rollback_started"
  | "rolled_back"
>

type CashWalletMigrationStepHandler = (
  migration: CashWalletMigration,
) => Promise<CashWalletMigration | ApplicationError>

export type CashWalletMigrationStepHandlers = Record<
  RunnableCashWalletMigrationStatus,
  CashWalletMigrationStepHandler
>

const terminalStatuses: CashWalletMigrationStatus[] = [
  "complete",
  "failed",
  "requires_operator_review",
  "skipped_already_migrated",
  "rollback_started",
  "rolled_back",
]

export const executeCashWalletMigrationStep = async ({
  migration,
  handlers,
}: {
  migration: CashWalletMigration
  handlers: CashWalletMigrationStepHandlers
}): Promise<CashWalletMigration | ApplicationError> => {
  if (terminalStatuses.includes(migration.status)) return migration

  return handlers[migration.status as RunnableCashWalletMigrationStatus](migration)
}
