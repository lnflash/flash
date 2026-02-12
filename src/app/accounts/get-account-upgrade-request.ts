import { UpgradeRequestQueryError } from "@services/frappe/errors"
import ErpNext from "@services/frappe/ErpNext"
import { AccountUpgradeRequest } from "@services/frappe/models/AccountUpgradeRequest"

export const getAccountUpgradeRequest = async (
  username: string,
): Promise<AccountUpgradeRequest | UpgradeRequestQueryError> => {
  if (!ErpNext) {
    return new UpgradeRequestQueryError("ERPNext service not configured")
  }
  return ErpNext.getAccountUpgradeRequest(username)
}
