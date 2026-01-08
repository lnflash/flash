import { updateAccountLevel } from "@app/accounts/update-account-level"
import { AccountsRepository } from "@services/mongoose"
import ErpNext from "@services/frappe/ErpNext"

type DecideUpgradeRequestInput = {
  requestName: string
  approve: boolean
}

export const decideUpgradeRequest = async ({
  requestName,
  approve,
}: DecideUpgradeRequestInput): Promise<true | ApplicationError> => {
  if (!ErpNext) {
    return new Error("ERPNext service not configured") as ApplicationError
  }

  const status = approve ? "Approved" : "Rejected"

  // Update ERPNext status first
  const updateResult = await ErpNext.updateUpgradeRequestStatus(requestName, status)
  if (updateResult instanceof Error) return updateResult

  // If approved, also update MongoDB account level
  if (approve) {
    // Fetch the request to get username and requested level
    const request = await ErpNext.getAccountUpgradeRequestByName(requestName)
    if (request instanceof Error) return request

    // Find the account by username
    const account = await AccountsRepository().findByUsername(
      request.username as Username,
    )
    if (account instanceof Error) return account

    // Update the account level
    const levelUpdateResult = await updateAccountLevel({
      id: account.id,
      level: request.requestedLevel,
    })
    if (levelUpdateResult instanceof Error) return levelUpdateResult
  }

  return true
}
