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
  // Cohort accountIds that were requested but not found among unlocked
  // accounts — surfaced so the operator notices typos/locked/missing ids.
  cohortNotFound?: AccountId[]
}

export const preparePrimaryCashWalletCutover = async ({
  cutoverVersion,
  runId,
  accountsRepo,
  walletsRepo,
  migrationsRepo,
  accountIds,
}: {
  cutoverVersion: number
  runId: string
  accountsRepo: Pick<IAccountsRepository, "listUnlockedAccounts">
  walletsRepo: Pick<IWalletsRepository, "listByAccountId">
  migrationsRepo: CashWalletMigrationRecordsRepository
  // Phased cutover (runbook: internal accounts first, then beta cohort).
  // When set, only these accounts are prepared; everything else is left
  // untouched. When omitted, the whole unlocked population is prepared.
  accountIds?: AccountId[]
}): Promise<PreparePrimaryCashWalletCutoverResult | RepositoryError> => {
  const allDiscoveries = await discoverCashWalletCutoverAccounts({
    accountsRepo,
    walletsRepo,
  })
  if (allDiscoveries instanceof Error) return allDiscoveries

  let discoveries = allDiscoveries
  let cohortNotFound: AccountId[] | undefined
  if (accountIds !== undefined) {
    const requested = new Set<string>(accountIds)
    discoveries = allDiscoveries.filter((d) => requested.has(d.accountId))
    const found = new Set<string>(discoveries.map((d) => d.accountId))
    cohortNotFound = accountIds.filter((id) => !found.has(id))
  }

  const report = buildCashWalletCutoverPreflightReport({
    cutoverVersion,
    runId,
    discoveries,
  })

  if (!report.canStart) {
    return { report, plannedMigrations: [], migrations: [], cohortNotFound }
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

  return { report, plannedMigrations, migrations, cohortNotFound }
}
