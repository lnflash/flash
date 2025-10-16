import { InvalidAccountStatusError } from "@domain/errors"
import { checkedToAccountLevel } from "@domain/accounts"
import { AccountsRepository, UsersRepository } from "@services/mongoose"

/**
 * Request an account level upgrade.
 *
 * This function allows users to request an upgrade to their account level (KYC level).
 * The request is stored as `requestedLevel` on the user record and must be approved
 * by an admin using the admin `accountUpdateLevel` mutation.
 *
 * Key behaviors:
 * - Users can only request upgrades, not downgrades
 * - Users can skip levels (e.g., request from 0 to 2 directly)
 * - Previous pending requests are replaced by new requests
 *
 * @param accountId - The account requesting the upgrade
 * @param level - The target account level (0, 1, 2, or 3)
 * @returns Success or an error
 */
export const requestAccountLevelUpgrade = async ({
  accountId,
  level,
}: {
  accountId: AccountId
  level: number
}): Promise<true | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  const usersRepo = UsersRepository()

  const account = await accountsRepo.findById(accountId)
  if (account instanceof Error) return account

  const checkedLevel = checkedToAccountLevel(level)
  if (checkedLevel instanceof Error) return checkedLevel

  // Prevent downgrade requests for security reasons
  if (checkedLevel < account.level) {
    return new InvalidAccountStatusError("Cannot request account level downgrade")
  }

  // Short-circuit if no change needed
  if (checkedLevel === account.level) {
    return new InvalidAccountStatusError("Account is already at requested level")
  }

  // Get user and set requested level
  const user = await usersRepo.findById(account.kratosUserId)
  if (user instanceof Error) return user

  const updatedUser = await usersRepo.update({
    ...user,
    requestedLevel: checkedLevel,
  })
  if (updatedUser instanceof Error) return updatedUser

  return true
}
