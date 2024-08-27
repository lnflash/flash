import { RepositoryError } from "@domain/errors"
import { AccountsRepository } from "@services/mongoose"
import { Account } from "@services/mongoose/schema"

export const npubPresent = async (
  npub: `npub1${string}`,
): Promise<boolean | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  console.log("Inside NpubPresent")
  const account = await accountsRepo.findByNpub(npub)
  if (account instanceof RepositoryError) return false
  return !!account.npub
}
