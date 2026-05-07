import { AccountLevel } from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { AccountsRepository } from "@services/mongoose"

export const updateAccountLevel = async ({
  id,
  level,
  erpParty,
}: {
  id: string
  level: AccountLevel
  erpParty?: string
}): Promise<Account | ApplicationError> => {
  if (
    (level === AccountLevel.Two || level === AccountLevel.Three) &&
    (!erpParty || erpParty.trim() === "")
  ) {
    return new ValidationError("erpParty is required for level 2 and 3 accounts")
  }

  const accountsRepo = AccountsRepository()

  const account = await accountsRepo.findById(id as AccountId)
  if (account instanceof Error) return account

  account.level = level
  if (erpParty !== undefined) account.erpParty = erpParty
  return accountsRepo.update(account)
}
