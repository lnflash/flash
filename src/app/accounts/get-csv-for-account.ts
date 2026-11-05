import { InvalidWalletForAccountError } from "@domain/accounts"
import { CsvWalletsExport } from "@services/ledger/csv-wallet-export"
import { WalletsRepository } from "@services/mongoose"

export const getCSVForAccount = async (
  accountId: AccountId,
  walletIds: readonly WalletId[],
): Promise<string | ApplicationError> => {
  if (!Array.isArray(walletIds)) return new InvalidWalletForAccountError()
  const wallets = await WalletsRepository().listByAccountId(accountId)
  if (wallets instanceof Error) return wallets

  const ownedById = new Map(
    wallets
      .filter((wallet) => wallet.accountId === accountId)
      .map((wallet) => [wallet.id, wallet]),
  )
  const selected: Wallet[] = []
  for (const walletId of new Set(walletIds)) {
    if (typeof walletId !== "string") return new InvalidWalletForAccountError()
    const wallet = ownedById.get(walletId as WalletId)
    if (!wallet) return new InvalidWalletForAccountError()
    selected.push(wallet)
  }

  const csv = new CsvWalletsExport()

  const error = await csv.addWallets(selected)
  if (error instanceof Error) return error

  return csv.getBase64()
}
