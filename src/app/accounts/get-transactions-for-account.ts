import { AccountValidator } from "@domain/accounts"
import { RepositoryError } from "@domain/errors"
import { WalletsRepository } from "@services/mongoose"

import { getTransactionsForWallets } from "../wallets"
import { PartialResult } from "../partial-result"

export const getTransactionsForAccountByWalletIds = async ({
  account,
  walletIds,
  paginationArgs,
}: {
  account: Account
  walletIds: WalletId[]
  paginationArgs?: PaginationArgs
}): Promise<PartialResult<PaginatedArray<BaseWalletTransaction>>> => {
  const walletsRepo = WalletsRepository()

  const wallets: Wallet[] = []
  for (const walletId of walletIds) {
    const wallet = await walletsRepo.findById(walletId)
    if (wallet instanceof RepositoryError) return PartialResult.err(wallet)

    const accountValidator = AccountValidator(account)
    const isActive = accountValidator.isActive()
    if (isActive instanceof Error) return PartialResult.err(isActive)
    const validateWallet = accountValidator.validateWalletForAccount(wallet)
    if (validateWallet instanceof Error) return PartialResult.err(validateWallet)

    wallets.push(wallet)
  }

  return getTransactionsForWallets({ wallets, paginationArgs })
}
