import ErpNext from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"

import {
  AccountLevel,
  deriveCapabilitiesForAccount,
  deriveStatusHeadline,
} from "@domain/accounts"

export type AccountCapabilityPresentation = {
  capabilities: AccountCapabilities
  statusHeadline: AccountStatusHeadline
}

// Read model for ENG-516: derive the account's capability flags and the
// user-facing headline status from what is actually on file. The bank-payout
// lookup goes to ERPNext; when ERPNext is unreachable (or the account has no
// ERP party yet) the stored level stands in via the grandfathering rule in
// deriveCapabilitiesForAccount, so the field degrades rather than errors.
export const getAccountCapabilities = async (
  account: Account,
): Promise<AccountCapabilityPresentation> => {
  let hasBankAccountOnFile = false
  if (account.erpParty && ErpNext) {
    const bankAccounts = await ErpNext.getBankAccountsByCustomer(account.erpParty)
    if (bankAccounts instanceof Error) {
      baseLogger.warn(
        { err: bankAccounts, accountId: account.id },
        "getAccountCapabilities: bank account lookup failed, falling back to stored level",
      )
      hasBankAccountOnFile = account.level >= AccountLevel.Two
    } else {
      hasBankAccountOnFile = bankAccounts.length > 0
    }
  }

  const capabilities = deriveCapabilitiesForAccount({
    level: account.level,
    hasBankAccountOnFile,
    bridgeKycStatus: account.bridgeKycStatus,
  })

  return { capabilities, statusHeadline: deriveStatusHeadline(capabilities) }
}
