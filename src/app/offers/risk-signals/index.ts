// Cash-out risk signals (ENG-889): the lookups.
//
// getCashoutRiskSignals never throws and never rejects: any lookup error is
// logged and turns into an "unavailable" signal, and the whole read is capped
// by a timeout so a slow ERPNext or Bridge cannot hold up the cash-out.

import { toBridgeCustomerId } from "@domain/primitives/bridge"
import BridgeApiClient from "@services/bridge/client"
import ErpNext from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"

import {
  CashoutRiskSignals,
  DepositSignals,
  accountAgeDays,
  buildDepositSignals,
  depositWindowStart,
  isNameMismatch,
  isNewAccount,
  toRecentBridgeDeposit,
} from "./signals"

export * from "./signals"

export const RISK_SIGNALS_TIMEOUT_MS = 5_000

type RiskAccount = Pick<Account, "id" | "createdAt" | "erpParty" | "bridgeCustomerId">

const bridgeKycName = async (bridgeCustomerId: string): Promise<string | undefined> => {
  try {
    const customer = await BridgeApiClient.getCustomer(
      toBridgeCustomerId(bridgeCustomerId),
    )
    if (customer.type === "business") return customer.business_name || undefined
    const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ")
    return name || undefined
  } catch (error) {
    baseLogger.warn(
      { err: error, bridgeCustomerId },
      "Cash-out risk signals: Bridge customer name lookup failed; comparing with the ERPNext name only",
    )
    return undefined
  }
}

const depositSignals = async (
  account: RiskAccount,
  now: Date,
): Promise<DepositSignals> => {
  const holderNames = account.erpParty ? [account.erpParty] : []

  // No Bridge customer means no Bridge virtual account, so no Bridge deposits.
  if (!account.bridgeCustomerId) {
    return buildDepositSignals({ deposits: [], holderNames, now })
  }

  const rows = await ErpNext.listRecentBridgeDepositRows({
    bridgeCustomerId: account.bridgeCustomerId,
    since: depositWindowStart(now),
  })
  if (rows instanceof Error) {
    baseLogger.warn(
      { err: rows, accountId: account.id },
      "Cash-out risk signals: Bridge deposit lookup failed",
    )
    return { available: false }
  }

  const deposits = rows.map(toRecentBridgeDeposit)

  // The ERPNext customer name may differ in form from the name on the KYC
  // record, so the Bridge KYC name is fetched only when the ERPNext name alone
  // would raise a mismatch.
  if (deposits.some((d) => isNameMismatch(d, holderNames))) {
    const kycName = await bridgeKycName(account.bridgeCustomerId)
    if (kycName) holderNames.push(kycName)
  }

  return buildDepositSignals({ deposits, holderNames, now })
}

const gather = async (account: RiskAccount, now: Date): Promise<CashoutRiskSignals> => {
  const ageDays = accountAgeDays(account.createdAt, now)
  return {
    available: true,
    accountAgeDays: ageDays,
    newAccount: isNewAccount(ageDays),
    deposits: await depositSignals(account, now),
  }
}

// Runs a read under the never-throw guard and the timeout: any error, thrown
// or returned, and a read slower than `timeoutMs` become { available: false }.
const guarded = async (
  read: () => Promise<CashoutRiskSignals>,
  accountId: AccountId | undefined,
  timeoutMs: number,
): Promise<CashoutRiskSignals> => {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Risk signal lookup timed out after ${timeoutMs} ms`)),
        timeoutMs,
      )
    })
    return await Promise.race([read(), timeout])
  } catch (error) {
    baseLogger.warn(
      { err: error, accountId },
      "Cash-out risk signals unavailable; the cash-out goes ahead without them",
    )
    return { available: false }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const getCashoutRiskSignals = async ({
  account,
  now = new Date(),
  timeoutMs = RISK_SIGNALS_TIMEOUT_MS,
}: {
  account: RiskAccount | undefined
  now?: Date
  timeoutMs?: number
}): Promise<CashoutRiskSignals> =>
  guarded(
    async () => {
      if (!account) throw new Error("No account on the cash-out offer")
      return gather(account, now)
    },
    account?.id,
    timeoutMs,
  )

// The same read, starting from the account id: the account lookup itself runs
// under the guard and the timeout, so a failed or slow lookup is an
// "unavailable" signal like any other.
export const getCashoutRiskSignalsForAccountId = async ({
  accountId,
  now = new Date(),
  timeoutMs = RISK_SIGNALS_TIMEOUT_MS,
}: {
  accountId: AccountId
  now?: Date
  timeoutMs?: number
}): Promise<CashoutRiskSignals> =>
  guarded(
    async () => {
      const account = await AccountsRepository().findById(accountId)
      if (account instanceof Error) throw account
      if (!account) throw new Error("Cash-out account not found")
      return gather(account, now)
    },
    accountId,
    timeoutMs,
  )
