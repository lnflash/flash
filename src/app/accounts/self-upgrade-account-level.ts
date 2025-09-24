import { InvalidAccountStatusError } from "@domain/errors"
import { checkedToAccountLevel } from "@domain/accounts"
import { AccountsRepository, UsersRepository } from "@services/mongoose"

/**
 * Self-service account level upgrade for authenticated users.
 *
 * This function allows users to upgrade their account level (KYC level) themselves,
 * but only if they have been validated by an admin/system first.
 *
 * Key behaviors:
 * - Users can only upgrade, not downgrade their level
 * - Users can skip levels (e.g., go from 0 to 2 directly)
 * - The 'validated' flag is reset after each upgrade to ensure single-use validation
 * - Validation must be explicitly set by admin/system for each upgrade
 *
 * @param accountId - The account to upgrade
 * @param level - The target account level (0, 1, 2, or 3)
 * @returns The updated account or an error
 */
export const selfUpgradeAccountLevel = async ({
  accountId,
  level,
}: {
  accountId: AccountId
  level: number
}): Promise<Account | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  const usersRepo = UsersRepository()

  const account = await accountsRepo.findById(accountId)
  if (account instanceof Error) return account

  const checkedLevel = checkedToAccountLevel(level)
  if (checkedLevel instanceof Error) return checkedLevel

  // Prevent downgrades for security reasons
  if (checkedLevel < account.level) {
    return new InvalidAccountStatusError("Cannot downgrade account level")
  }

  // Short-circuit if no change needed
  if (checkedLevel === account.level) {
    return account
  }

  // Verify user has been validated for this upgrade
  const user = await usersRepo.findById(account.kratosUserId)
  if (user instanceof Error) return user

  if (!user.validated) {
    return new InvalidAccountStatusError("User must be validated to upgrade account level")
  }

  // Perform the account level upgrade
  account.level = checkedLevel
  const updatedAccount = await accountsRepo.update(account)
  if (updatedAccount instanceof Error) return updatedAccount

  // Reset validation flag to ensure one-time use
  // This creates an audit trail: admin validates → user upgrades → flag resets
  await usersRepo.update({
    ...user,
    validated: false,
  })

  return updatedAccount
}