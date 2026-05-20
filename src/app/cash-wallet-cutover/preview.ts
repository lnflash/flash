import { AccountsRepository, WalletsRepository } from "@services/mongoose"

import { discoverCashWalletCutoverAccounts } from "./discovery"
import {
  buildCashWalletCutoverPreflightReport,
  CashWalletCutoverPreflightReport,
} from "./preflight"
import {
  buildPrimaryCashWalletMigrationPlan,
  PrimaryCashWalletMigrationPlan,
} from "./planner"

export const previewPrimaryCashWalletCutover = async ({
  cutoverVersion,
  runId,
  accountsRepo = AccountsRepository(),
  walletsRepo = WalletsRepository(),
}: {
  cutoverVersion: number
  runId: string
  accountsRepo?: Pick<IAccountsRepository, "listUnlockedAccounts">
  walletsRepo?: Pick<IWalletsRepository, "listByAccountId">
}): Promise<
  | {
      report: CashWalletCutoverPreflightReport
      plannedMigrations: PrimaryCashWalletMigrationPlan[]
    }
  | RepositoryError
> => {
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
    return { report, plannedMigrations: [] }
  }

  return {
    report,
    plannedMigrations: buildPrimaryCashWalletMigrationPlan({
      cutoverVersion,
      runId,
      discoveries,
    }),
  }
}
