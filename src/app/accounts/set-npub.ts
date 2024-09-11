import { AccountsRepository } from "@services/mongoose"
import { checkValidNpub } from "@domain/nostr"

import { ValidationError } from "ajv"

export const setNpub = async ({
  id,
  npub,
}: {
  id: AccountId
  npub: Npub
}): Promise<Account | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  if (!checkValidNpub(npub))
    throw new ValidationError([{ message: "Invalid npub format" }])
  const account = await accountsRepo.findById(id)
  if (account instanceof Error) return account
  account.npub = npub
  return accountsRepo.update(account)
}
