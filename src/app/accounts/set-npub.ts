import { AccountsRepository } from "@services/mongoose"

import { ValidationError } from "ajv"

export const setNpub = async ({
  id,
  npub,
}: {
  id: string
  npub: `npub1${string}`
}): Promise<Account | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  if (!checkValidNpub(npub))
    throw new ValidationError([{ message: "Invalid npub format" }])
  const account = await accountsRepo.findById(id as AccountId)
  if (account instanceof Error) return account
  account.npub = npub
  return accountsRepo.update(account)
}

const checkValidNpub = (npub: string): boolean => {
  if (npub.startsWith("npub1") && npub.length === 63) return true
  return false
}
