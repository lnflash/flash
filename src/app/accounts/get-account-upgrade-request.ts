import { UpgradeRequestQueryError } from "@services/frappe/errors"
import ErpNext from "@services/frappe/ErpNext"
import { AccountUpgradeRequest, RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"

export const getAccountUpgradeRequests = async (
  filters: { username: string, status: RequestStatus, count: number } 
): Promise<AccountUpgradeRequest[] | UpgradeRequestQueryError> => {
  if (!ErpNext) {
    return new UpgradeRequestQueryError("ERPNext service not configured")
  }
  const ids = await ErpNext.getAccountUpgradeRequestList(filters)
  if (ids instanceof UpgradeRequestQueryError) return ids
  const upgradeRequests = await Promise.all(ids.slice(0, filters.count).map(_ => ErpNext.getAccountUpgradeRequestById(_)))
  return findErrors(upgradeRequests)
}

const findErrors = (erpnextResponses: (AccountUpgradeRequest | UpgradeRequestQueryError)[]): AccountUpgradeRequest[] | UpgradeRequestQueryError => {
  return erpnextResponses.find((r): r is UpgradeRequestQueryError => r instanceof UpgradeRequestQueryError) 
    || erpnextResponses as AccountUpgradeRequest[]
}