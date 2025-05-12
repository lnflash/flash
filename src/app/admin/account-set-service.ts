import { getAccount } from "@app/accounts"
import { AccountsRepository } from "@services/mongoose"
import { baseLogger } from "@services/logger"

export const setAccountService = async ({
  accountId,
  isServiceAccount,
}: {
  accountId: AccountId
  isServiceAccount: boolean
}): Promise<Account | ApplicationError> => {
  const logger = baseLogger.child({
    topic: "set-account-service",
    accountId,
  })

  // Get account to validate it exists
  const account = await getAccount(accountId)
  if (account instanceof Error) {
    return account
  }

  logger.info(
    { 
      accountId: account.id, 
      isServiceAccount, 
      previousValue: account.isServiceAccount 
    }, 
    "Updating account service status"
  )

  try {
    // Update account
    const accounts = AccountsRepository()
    const result = await accounts.updateIsServiceAccount({
      accountId: account.id,
      isServiceAccount,
    })

    if (result instanceof Error) {
      logger.error({ error: result }, "Failed to update account service status")
      return result
    }

    return result
  } catch (error: unknown) {
    const err = error as Error
    logger.error({ error: err }, "Failed to update account service status")
    return err
  }
}