import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

export type CashWalletCutoverDiscoveryStatus =
  | "legacy_default"
  | "already_usdt"
  | "residual_legacy_usd"
  | "missing_legacy_usd"
  | "missing_destination_usdt"

export type CashWalletCutoverDiscovery = {
  status: CashWalletCutoverDiscoveryStatus
  accountId: AccountId
  accountUuid?: AccountUuid
  legacyUsdWalletId?: WalletId
  destinationUsdtWalletId?: WalletId
  previousDefaultWalletId: WalletId
}

export const classifyCashWalletsForCutover = ({
  account,
  wallets,
}: {
  account: Account
  wallets: Wallet[]
}): CashWalletCutoverDiscovery => {
  const legacyUsdWallet = wallets.find(
    (wallet) =>
      wallet.type === WalletType.Checking && wallet.currency === WalletCurrency.Usd,
  )
  const destinationUsdtWallet = wallets.find(
    (wallet) =>
      wallet.type === WalletType.Checking && wallet.currency === WalletCurrency.Usdt,
  )

  const base = {
    accountId: account.id,
    accountUuid: account.uuid,
    legacyUsdWalletId: legacyUsdWallet?.id,
    destinationUsdtWalletId: destinationUsdtWallet?.id,
    previousDefaultWalletId: account.defaultWalletId,
  }

  if (!legacyUsdWallet) return { ...base, status: "missing_legacy_usd" }
  if (!destinationUsdtWallet) return { ...base, status: "missing_destination_usdt" }

  if (account.defaultWalletId === legacyUsdWallet.id) {
    return { ...base, status: "legacy_default" }
  }

  if (account.defaultWalletId === destinationUsdtWallet.id) {
    return { ...base, status: "already_usdt" }
  }

  return { ...base, status: "residual_legacy_usd" }
}

export const discoverCashWalletCutoverAccounts = async ({
  accountsRepo,
  walletsRepo,
}: {
  accountsRepo: Pick<IAccountsRepository, "listUnlockedAccounts">
  walletsRepo: Pick<IWalletsRepository, "listByAccountId">
}): Promise<CashWalletCutoverDiscovery[] | RepositoryError> => {
  const accounts = accountsRepo.listUnlockedAccounts()
  if (accounts instanceof Error) return accounts

  const discoveries: CashWalletCutoverDiscovery[] = []

  for await (const account of accounts) {
    const wallets = await walletsRepo.listByAccountId(account.id)
    if (wallets instanceof Error) return wallets

    discoveries.push(classifyCashWalletsForCutover({ account, wallets }))
  }

  return discoveries
}
