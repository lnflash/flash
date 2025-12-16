import { InvalidAccountStatusError } from "@domain/errors"
import { checkedToAccountLevel } from "@domain/accounts"
import { AccountsRepository, UsersRepository } from "@services/mongoose"
import { IdentityRepository } from "@services/kratos"
import ErpNext from "@services/frappe/ErpNext"
import { updateAccountLevel } from "./update-account-level"

type BusinessUpgradeRequestInput = {
  accountId: AccountId
  level: number
  fullName: string
}

export const businessAccountUpgradeRequest = async (
  input: BusinessUpgradeRequestInput,
): Promise<true | ApplicationError> => {
  const { accountId, level, fullName } = input

  const accountsRepo = AccountsRepository()
  const usersRepo = UsersRepository()

  const account = await accountsRepo.findById(accountId)
  if (account instanceof Error) return account

  const checkedLevel = checkedToAccountLevel(level)
  if (checkedLevel instanceof Error) return checkedLevel

  if (checkedLevel < account.level) {
    return new InvalidAccountStatusError("Cannot request account level downgrade")
  }

  if (checkedLevel === account.level) {
    return new InvalidAccountStatusError("Account is already at requested level")
  }

  const user = await usersRepo.findById(account.kratosUserId)
  if (user instanceof Error) return user

  const identity = await IdentityRepository().getIdentity(account.kratosUserId)
  if (identity instanceof Error) return identity

  const requestResult = await ErpNext.createUpgradeRequest({
    currentLevel: account.level,
    requestedLevel: checkedLevel,
    username: (account.username as string) || account.id,
    fullName,
    phoneNumber: (user.phone as string) || "",
    email: identity.email as string | undefined,
  })

  if (requestResult instanceof Error) return requestResult

  // Level 2 (Pro) auto-upgrades immediately
  if (checkedLevel === 2) {
    const upgradeResult = await updateAccountLevel({
      id: accountId,
      level: checkedLevel,
    })
    if (upgradeResult instanceof Error) return upgradeResult
  }

  return true
}
