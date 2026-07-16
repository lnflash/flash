import { AccountsRepository } from "@services/mongoose"
import { ValidationError } from "@domain/shared"
import {
  AccountLevel,
  RequestableCapability,
  deriveLevelFromCapabilities,
} from "@domain/accounts"

import type { BankAccount } from "@services/frappe/models/BankAccount"

import { createUpgradeRequest, type Address } from "./business-account-upgrade-request"
import { getAccountCapabilities } from "./get-account-capabilities"

export type CapabilityUpgradeRequest = {
  capability: RequestableCapability
  fullName: string
  address: Address
  terminalsRequested: number
  bankAccount?: BankAccount
  idDocument?: string
}

// ENG-516: "add a capability" transition. Instead of the client picking a
// whole tier (the retired Pro/Merchant/International nomenclature), it asks
// for one capability; the target internal level is derived from the account's
// current capabilities plus the requested one, and the request travels down
// the existing ERPNext Account Upgrade Request pipeline for human review.
export const requestCapabilityUpgrade = async (
  accountId: AccountId,
  input: CapabilityUpgradeRequest,
): Promise<ReturnType<typeof createUpgradeRequest>> => {
  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const { capabilities } = await getAccountCapabilities(account)

  // verified (phone + ID) is a prerequisite for every capability upgrade.
  // deriveLevelFromCapabilities returns L0 for an unverified account, so a
  // request from one would otherwise be turned into a structurally-invalid,
  // level-skipping L2 ERPNext request. verified is granted by the identity
  // flow, not requestable here.
  if (!capabilities.verified) {
    return new ValidationError(
      "Account must complete identity verification before requesting an upgrade",
    )
  }

  if (capabilities[input.capability]) {
    return new ValidationError(`Account already has the ${input.capability} capability`)
  }

  // Per-capability requirements. Business also needs a bank account on file
  // (it is part of the L3 requirements) but not re-submitted if one exists.
  if (input.capability === RequestableCapability.BankPayout && !input.bankAccount) {
    return new ValidationError("Bank account details are required for bank payout")
  }
  if (
    input.capability === RequestableCapability.Business &&
    !input.bankAccount &&
    !capabilities.bankPayout
  ) {
    return new ValidationError(
      "Bank account details are required to set up a business account",
    )
  }

  const targetCapabilities = {
    ...capabilities,
    [input.capability]: true,
    // A submitted bank account also satisfies bankPayout on the way to business.
    bankPayout: capabilities.bankPayout || input.bankAccount !== undefined,
  }
  const level = deriveLevelFromCapabilities(targetCapabilities)

  const base = {
    accountId,
    fullName: input.fullName,
    address: input.address,
    terminalsRequested: input.terminalsRequested,
    idDocument: input.idDocument ?? "",
  }

  if (level === AccountLevel.Three) {
    return createUpgradeRequest(accountId, {
      ...base,
      level: AccountLevel.Business,
      // May be undefined: the bank account is already on file in ERPNext
      // (capabilities.bankPayout was checked above), so none is re-submitted.
      bankAccount: input.bankAccount,
    })
  }

  return createUpgradeRequest(accountId, {
    ...base,
    level: AccountLevel.Two,
    bankAccount: input.bankAccount,
  })
}
