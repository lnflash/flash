import { WalletsRepository, CashWalletCutoverRepository } from "@services/mongoose"

import { CashWalletClientCapabilities } from "./client-capability"
import { CashWalletCutoverPreflightError } from "./errors"
import { evaluateCashWalletCutoverPresentation } from "./guard"
import {
  CashWalletPresentationResult,
  resolveCashWalletPresentation,
} from "./presentation"

type CashWalletPresentationMigrationsRepository = {
  getConfig: () => Promise<CashWalletCutoverConfig | RepositoryError>
  findMigrationByAccountId: ({
    accountId,
    cutoverVersion,
    runId,
  }: {
    accountId: AccountId
    cutoverVersion: number
    runId: string
  }) => Promise<CashWalletMigration | RepositoryError | null>
}

type CashWalletPresentationWalletsRepository = {
  listByAccountId: (accountId: AccountId) => Promise<Wallet[] | RepositoryError>
}

export const resolveCashWalletPresentationForAccount = async ({
  account,
  client,
  migrationsRepo = CashWalletCutoverRepository(),
  walletsRepo = WalletsRepository(),
}: {
  account: Account
  client: CashWalletClientCapabilities
  migrationsRepo?: CashWalletPresentationMigrationsRepository
  walletsRepo?: CashWalletPresentationWalletsRepository
}): Promise<CashWalletPresentationResult | ApplicationError> => {
  const cutover = await migrationsRepo.getConfig()
  if (cutover instanceof Error) return cutover

  let migration: CashWalletMigration | null | undefined
  if (cutover.state === "in_progress") {
    if (!cutover.runId) return new CashWalletCutoverPreflightError()

    const foundMigration = await migrationsRepo.findMigrationByAccountId({
      accountId: account.id,
      cutoverVersion: cutover.cutoverVersion,
      runId: cutover.runId,
    })
    if (foundMigration instanceof Error) return foundMigration
    migration = foundMigration
  }

  const decision = evaluateCashWalletCutoverPresentation({
    cutover,
    migration,
    client,
  })
  if (decision instanceof Error) return decision

  const wallets = await walletsRepo.listByAccountId(account.id)
  if (wallets instanceof Error) return wallets

  return resolveCashWalletPresentation({ decision, wallets })
}

export const resolveCashWalletMutationWalletIdForAccount = async ({
  account,
  walletId,
  client,
  migrationsRepo,
  walletsRepo,
}: {
  account: Account
  walletId: WalletId
  client: CashWalletClientCapabilities
  migrationsRepo?: CashWalletPresentationMigrationsRepository
  walletsRepo?: CashWalletPresentationWalletsRepository
}): Promise<WalletId | ApplicationError> => {
  const presentation = await resolveCashWalletPresentationForAccount({
    account,
    client,
    migrationsRepo,
    walletsRepo,
  })
  if (presentation instanceof Error) return presentation

  if (walletId === presentation.legacyUsdWallet?.id) {
    return presentation.activeSettlementWallet.id
  }

  return walletId
}
