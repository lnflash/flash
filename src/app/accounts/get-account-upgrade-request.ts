import { UpgradeRequestQueryError } from "@services/frappe/errors"
import ErpNext from "@services/frappe/ErpNext"
import { AccountUpgradeRequest, RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"

export const getAccountUpgradeRequests = async (
  filters: { username: string, status: RequestStatus, count: number } 
): Promise<AccountUpgradeRequest[] | UpgradeRequestQueryError> => {
  if (!ErpNext) {
    return new UpgradeRequestQueryError("ERPNext service not configured")
  }
  const pendingRequests = await ErpNext.getAccountUpgradeRequestList(filters)
  if (pendingRequests instanceof UpgradeRequestQueryError) return pendingRequests
  const results = await Promise.all(pendingRequests.slice(0, filters.count).map(pr => {
    const { name } = pr
    return ErpNext.getAccountUpgradeRequestById(name)
  }))
  const err = results.find((r): r is UpgradeRequestQueryError => r instanceof UpgradeRequestQueryError)
  if (err) return err
  return results as AccountUpgradeRequest[]
}
