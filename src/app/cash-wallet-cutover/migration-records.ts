type CashWalletMigrationRecordsRepository = {
  upsertMigration(
    args: PrimaryCashWalletMigrationPlan,
  ): Promise<CashWalletMigration | RepositoryError>
}

export type { CashWalletMigrationRecordsRepository }

export const upsertPrimaryCashWalletMigrationRecords = async ({
  migrationsRepo,
  plans,
}: {
  migrationsRepo: CashWalletMigrationRecordsRepository
  plans: PrimaryCashWalletMigrationPlan[]
}): Promise<CashWalletMigration[] | RepositoryError> => {
  const migrations: CashWalletMigration[] = []

  for (const plan of plans) {
    const migration = await migrationsRepo.upsertMigration(plan)
    if (migration instanceof Error) return migration

    migrations.push(migration)
  }

  return migrations
}
