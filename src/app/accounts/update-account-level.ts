import { AccountLevel } from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { notifyOpsEvent } from "@services/alerts/ops-events"
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

  const previousLevel = account.level
  account.level = level
  if (erpParty !== undefined) account.erpParty = erpParty
  const updated = await accountsRepo.update(account)
  if (updated instanceof Error) return updated

  notifyOpsEvent({
    flow: "upgrade",
    phase: "approved",
    status: "success",
    accountId: updated.id,
    meta: { from: String(previousLevel), to: String(level) },
  })

  return updated
}
