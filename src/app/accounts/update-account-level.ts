import { AccountsRepository, UsersRepository } from "@services/mongoose"

export const updateAccountLevel = async ({
  id,
  level,
}: {
  id: string
  level: AccountLevel
}): Promise<Account | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  const usersRepo = UsersRepository()

  const account = await accountsRepo.findById(id as AccountId)
  if (account instanceof Error) return account

  account.level = level
  const updatedAccount = await accountsRepo.update(account)
  if (updatedAccount instanceof Error) return updatedAccount

  // Clear any pending upgrade request when admin changes level
  const user = await usersRepo.findById(account.kratosUserId)
  if (user instanceof Error) return updatedAccount // Don't fail the whole operation

  if (user.requestedLevel !== null) {
    await usersRepo.update({
      ...user,
      requestedLevel: null,
    })
  }

  return updatedAccount
}
