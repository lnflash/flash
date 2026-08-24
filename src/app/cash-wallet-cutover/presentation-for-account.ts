import { WalletsRepository, CashWalletCutoverRepository } from "@services/mongoose"

import { CashWalletClientCapabilities } from "./client-capability"
import {
  CashWalletCutoverPreflightError,
  CashWalletMissingUsdtWalletError,
} from "./errors"
import { ensureUsdtWalletForAccount as ensureUsdtWallet } from "./ensure-usdt-wallet"
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
  // Optional: injected repos that also carry persistNew (e.g. the real
  // WalletsRepository) get the self-heal's create routed through them too;
  // list-only repos fall back to the real repo for the create.
  persistNew?: (args: NewWalletInfo) => Promise<Wallet | ApplicationError>
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

  const presentation = resolveCashWalletPresentation({ decision, wallets })

  // ENG-544 self-heal. Accounts predating the cutover can lack the USDT
  // wallet the decision demands, which used to surface as
  // CashWalletMissingUsdtWalletError on EVERY usdt-presentation path —
  // including accountDefaultWallet, i.e. lightning-address resolution, so
  // those accounts could not be paid at all. Converge the account here, once,
  // under an account-scoped lock (see ensureUsdtWalletForAccount), and resolve
  // against the healed wallet list. On creation failure this falls through to
  // the original error: the account is no better off, but never worse, and the
  // next resolution retries.
  if (presentation instanceof CashWalletMissingUsdtWalletError) {
    const created = await ensureUsdtWallet({ account, walletsRepo })
    if (created) {
      return resolveCashWalletPresentation({ decision, wallets: [...wallets, created] })
    }
  }

  return presentation
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
