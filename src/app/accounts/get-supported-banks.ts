import { BanksQueryError } from "@services/frappe/errors"
import ErpNext from "@services/frappe/ErpNext"
import { Bank } from "@services/frappe/models/Bank"

export const getSupportedBanks = async (): Promise<Bank[] | BanksQueryError> => {
  if (!ErpNext) {
    return new BanksQueryError("ERPNext service not configured")
  }
  return ErpNext.listBanks()
}
