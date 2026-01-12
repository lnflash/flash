import { UpgradeRequestQueryError } from "@services/frappe/errors"
import ErpNext from "@services/frappe/ErpNext"

export const getAccountUpgradeRequest = async (username: string) => {
  if (!ErpNext) {
    return new UpgradeRequestQueryError("ERPNext service not configured")
  }
  return ErpNext.getAccountUpgradeRequest(username)
}
