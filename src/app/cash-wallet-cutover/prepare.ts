import {
  buildCashWalletCutoverPreflightReport,
  CashWalletCutoverPreflightReport,
} from "./preflight"
import { discoverCashWalletCutoverAccounts } from "./discovery"
import {
  buildPrimaryCashWalletMigrationPlan,
  PrimaryCashWalletMigrationPlan,
} from "./planner"
import {
  upsertPrimaryCashWalletMigrationRecords,
  CashWalletMigrationRecordsRepository,
} from "./migration-records"

type PreparePrimaryCashWalletCutoverResult = {
  report: CashWalletCutoverPreflightReport
  plannedMigrations: PrimaryCashWalletMigrationPlan[]
  migrations: CashWalletMigration[]
}

export const preparePrimaryCashWalletCutover = async ({
  cutoverVersion,
  runId,
  accountsRepo,
  walletsRepo,
  migrationsRepo,
}: {
  cutoverVersion: number
  runId: string
  accountsRepo: Pick<IAccountsRepository, "listUnlockedAccounts">
  walletsRepo: Pick<IWalletsRepository, "listByAccountId">
  migrationsRepo: CashWalletMigrationRecordsRepository
}): Promise<PreparePrimaryCashWalletCutoverResult | RepositoryError> => {
  const discoveries = await discoverCashWalletCutoverAccounts({
    accountsRepo,
    walletsRepo,
  })
  if (discoveries instanceof Error) return discoveries

  const report = buildCashWalletCutoverPreflightReport({
    cutoverVersion,
    runId,
    discoveries,
  })

  if (!report.canStart) {
    return { report, plannedMigrations: [], migrations: [] }
  }

  const plannedMigrations = buildPrimaryCashWalletMigrationPlan({
    cutoverVersion,
    runId,
    discoveries,
  })

  const migrations = await upsertPrimaryCashWalletMigrationRecords({
    migrationsRepo,
    plans: plannedMigrations,
  })
  if (migrations instanceof Error) return migrations

  return { report, plannedMigrations, migrations }
}
