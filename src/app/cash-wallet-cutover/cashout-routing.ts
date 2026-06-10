import { WalletCurrency } from "@domain/shared"
import { WalletsRepository, CashWalletCutoverRepository } from "@services/mongoose"

import {
  CashWalletMissingUsdtWalletError,
  CashWalletCutoverPreflightError,
} from "./errors"
import { CashWalletCutoverRoute, evaluateCashWalletCutoverGuard } from "./guard"

type CashoutRoutingMigrationsRepository = {
  getConfig: () => Promise<CashWalletCutoverConfig | RepositoryError>
  findMigrationByAccountId: (args: {
    accountId: AccountId
    cutoverVersion: number
    runId: string
  }) => Promise<CashWalletMigration | RepositoryError | null>
}

type CashoutRoutingWalletsRepository = {
  findById: (walletId: WalletId) => Promise<Wallet | RepositoryError>
  listByAccountId: (accountId: AccountId) => Promise<Wallet[] | RepositoryError>
}

export type CashoutWalletSelection = {
  route: CashWalletCutoverRoute
  userWalletId: WalletId
  flashWalletId: WalletId
}

// Resolves the source (user) and destination (Flash bank-owner) wallets for a
// Cashout V1 offer from the cutover guard — NOT from the client-supplied walletId.
// Pre-cutover this returns the legacy USD wallets unchanged; post-cutover it returns
// the account's USDT wallet and the bank-owner's USDT wallet so the debit settles in
// ETH-USDT. The guard blocks the cashout (returns an error) while a migration is
// in-flight or has failed.
export const resolveCashoutWalletSelection = async ({
  accountId,
  requestedUserWalletId,
  bankOwnerUsdWalletId,
  migrationsRepo = CashWalletCutoverRepository(),
  walletsRepo = WalletsRepository(),
}: {
  accountId: AccountId
  requestedUserWalletId: WalletId
  bankOwnerUsdWalletId: WalletId
  migrationsRepo?: CashoutRoutingMigrationsRepository
  walletsRepo?: CashoutRoutingWalletsRepository
}): Promise<CashoutWalletSelection | ApplicationError> => {
  const cutover = await migrationsRepo.getConfig()
  if (cutover instanceof Error) return cutover

  let migration: CashWalletMigration | null | undefined
  if (cutover.state === "in_progress") {
    if (!cutover.runId) return new CashWalletCutoverPreflightError()

    const foundMigration = await migrationsRepo.findMigrationByAccountId({
      accountId,
      cutoverVersion: cutover.cutoverVersion,
      runId: cutover.runId,
    })
    if (foundMigration instanceof Error) return foundMigration
    migration = foundMigration
  }

  const decision = evaluateCashWalletCutoverGuard({ cutover, migration })
  if (decision instanceof Error) return decision

  if (decision.route === "legacy_usd") {
    return {
      route: "legacy_usd",
      userWalletId: requestedUserWalletId,
      flashWalletId: bankOwnerUsdWalletId,
    }
  }

  const userWallets = await walletsRepo.listByAccountId(accountId)
  if (userWallets instanceof Error) return userWallets
  const userUsdtWallet = userWallets.find((w) => w.currency === WalletCurrency.Usdt)
  if (!userUsdtWallet) {
    return new CashWalletMissingUsdtWalletError(
      `No USDT wallet found for account ${accountId}`,
    )
  }

  const bankOwnerWallet = await walletsRepo.findById(bankOwnerUsdWalletId)
  if (bankOwnerWallet instanceof Error) return bankOwnerWallet
  const bankOwnerWallets = await walletsRepo.listByAccountId(bankOwnerWallet.accountId)
  if (bankOwnerWallets instanceof Error) return bankOwnerWallets
  const bankOwnerUsdtWallet = bankOwnerWallets.find(
    (w) => w.currency === WalletCurrency.Usdt,
  )
  if (!bankOwnerUsdtWallet) {
    return new CashWalletMissingUsdtWalletError(
      "No USDT wallet found for the Flash bank-owner account",
    )
  }

  return {
    route: "usdt",
    userWalletId: userUsdtWallet.id,
    flashWalletId: bankOwnerUsdtWallet.id,
  }
}
