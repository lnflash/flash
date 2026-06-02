import { AccountsRepository, WalletsRepository } from "@services/mongoose"

import { CashWalletClientCapabilities } from "./client-capability"
import { resolveCashWalletMutationWalletIdForAccount } from "./presentation-for-account"

type RecipientRoutingAccountsRepository = {
  findById(accountId: AccountId): Promise<Account | RepositoryError>
}

type RecipientRoutingWalletsRepository = {
  findById(walletId: WalletId): Promise<Wallet | RepositoryError>
  listByAccountId(accountId: AccountId): Promise<Wallet[] | RepositoryError>
}

type ResolveMutationWalletIdForAccount =
  typeof resolveCashWalletMutationWalletIdForAccount

export const resolveCashWalletRecipientMutationWalletId = async ({
  recipientWalletId,
  client,
  accountsRepo = AccountsRepository(),
  walletsRepo = WalletsRepository(),
  resolveMutationWalletIdForAccount = resolveCashWalletMutationWalletIdForAccount,
}: {
  recipientWalletId: WalletId
  client: CashWalletClientCapabilities
  accountsRepo?: RecipientRoutingAccountsRepository
  walletsRepo?: RecipientRoutingWalletsRepository
  resolveMutationWalletIdForAccount?: ResolveMutationWalletIdForAccount
}): Promise<WalletId | ApplicationError> => {
  const recipientWallet = await walletsRepo.findById(recipientWalletId)
  if (recipientWallet instanceof Error) return recipientWallet

  const recipientAccount = await accountsRepo.findById(recipientWallet.accountId)
  if (recipientAccount instanceof Error) return recipientAccount

  return resolveMutationWalletIdForAccount({
    account: recipientAccount,
    walletId: recipientWalletId,
    client,
    walletsRepo,
  })
}
