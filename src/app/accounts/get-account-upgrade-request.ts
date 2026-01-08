import ErpNext from "@services/frappe/ErpNext"
import { AccountUpgradeRequest } from "@services/frappe/models/AccountUpgradeRequest"

export const getAccountUpgradeRequest = async (
  username: string,
): Promise<AccountUpgradeRequest | ApplicationError> => {
  if (!ErpNext) {
    return new Error("ERPNext service not configured") as ApplicationError
  }
  return ErpNext.getAccountUpgradeRequest(username)
}
