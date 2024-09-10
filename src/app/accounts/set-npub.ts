import { AccountsRepository } from "@services/mongoose"

import { ValidationError } from "ajv"

export const setNpub = async ({
  id,
  npub,
}: {
  id: AccountId
  npub: `npub1${string}`
}): Promise<Account | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  if (!checkValidNpub(npub))
    throw new ValidationError([{ message: "Invalid npub format" }])
  const account = await accountsRepo.findById(id)
  if (account instanceof Error) return account
  account.npub = npub
  return accountsRepo.update(account)
}

export const checkValidNpub = (npub: string): boolean => {
  return npub.startsWith("npub1") && npub.length === 63
}
