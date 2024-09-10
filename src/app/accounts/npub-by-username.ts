import { checkedToUsername } from "@domain/accounts"
import { CouldNotFindAccountError, RepositoryError } from "@domain/errors"
import { AccountsRepository } from "@services/mongoose"
import { Account } from "@services/mongoose/schema"

export const npubByUsername = async (
  username: Username,
): Promise<{ npub: string; username: string } | ApplicationError> => {
  const checkedUsername = checkedToUsername(username)
  if (checkedUsername instanceof Error) return checkedUsername

  const accountsRepo = AccountsRepository()
  const account = await accountsRepo.findByUsername(checkedUsername)
  if (account instanceof RepositoryError) return new CouldNotFindAccountError()
  if (!account.npub) return new CouldNotFindAccountError()
  return { npub: account.npub, username: account.username }
}
