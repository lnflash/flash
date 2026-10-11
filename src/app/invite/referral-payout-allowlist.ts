/**
 * Cached reader for the ERPNext "Referral Payout Allowlist" doctype: the
 * accounts whose referral reward may pay while the global referral program
 * (helm `referralReward.enabled`) stays paused after the 2026-08-31 farming
 * wave. A referral pays when EITHER party (inviter or invitee) is listed;
 * both parties are still paid per the tier. The ERPNext Referral Settings
 * switch (referral-settings.ts) remains the master kill on top of this.
 *
 * FAIL-CLOSED, like referral-settings.ts. An unreadable, missing, malformed,
 * or empty allowlist means "nobody is allowlisted", so nothing pays. Do NOT
 * copy the polarity of services/frappe/fee-discounts.ts, which fails OPEN to
 * a 0% discount: here that copy error would turn an ERPNext outage into
 * payouts.
 *
 * Rows are keyed by the flash account id (Mongo `_id` string). frappe
 * resolves the operator's input to that id at save time, so this reader never
 * touches Mongo: it only reads `account_id` and `enabled`.
 *
 * Memoised for ~60s (successes AND failures) so a KYC-approval burst cannot
 * become an ERPNext fetch storm, while removing a row takes effect within a
 * minute.
 */
import { toBoolean } from "@services/frappe/coerce"
import ErpNext from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"

const CACHE_TTL_MS = 60_000

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{24}$/

let cache: { accountIds: Set<AccountId>; at: number } | undefined

export const resetReferralPayoutAllowlistCache = () => {
  cache = undefined
}

/**
 * The allowlisted account id of one raw row, or undefined when the row must
 * be dropped: not an object, not enabled, or an account_id that is not a
 * 24-hex ObjectId string. `enabled` is re-checked here even though the ERP
 * query filters on it, so a lost filter cannot re-enable a removed row.
 */
export const validateReferralPayoutAllowlistDoc = (
  doc: unknown,
): AccountId | undefined => {
  if (!doc || typeof doc !== "object") return undefined
  const { account_id: rawAccountId, enabled } = doc as {
    account_id?: unknown
    enabled?: unknown
  }
  if (!toBoolean(enabled)) return undefined
  if (typeof rawAccountId !== "string") return undefined
  const accountId = rawAccountId.trim().toLowerCase()
  if (!ACCOUNT_ID_PATTERN.test(accountId)) return undefined
  return accountId as AccountId
}

const fetchAllowlist = async (): Promise<Set<AccountId>> => {
  const docs = ErpNext?.getReferralPayoutAllowlist
    ? await ErpNext.getReferralPayoutAllowlist()
    : undefined

  if (docs instanceof Error || !Array.isArray(docs)) {
    baseLogger.warn(
      { error: docs },
      "Referral Payout Allowlist unreadable — treating it as EMPTY (no allowlisted payouts)",
    )
    return new Set()
  }

  const accountIds = new Set<AccountId>()
  for (const doc of docs) {
    const accountId = validateReferralPayoutAllowlistDoc(doc)
    if (accountId) accountIds.add(accountId)
    else {
      baseLogger.warn(
        { doc },
        "Referral Payout Allowlist: dropping malformed or disabled row",
      )
    }
  }
  return accountIds
}

const loadAllowlist = async (): Promise<Set<AccountId>> => {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.accountIds

  let accountIds: Set<AccountId>
  try {
    accountIds = await fetchAllowlist()
  } catch (err) {
    baseLogger.warn(
      { err },
      "Referral Payout Allowlist load threw — treating it as EMPTY (no allowlisted payouts)",
    )
    accountIds = new Set()
  }

  cache = { accountIds, at: now }
  return accountIds
}

/** True only when the account is on a readable, enabled allowlist row. Never throws. */
export const accountAllowlistedForReferralPayout = async (
  accountId: AccountId,
): Promise<boolean> => {
  try {
    const accountIds = await loadAllowlist()
    return accountIds.has(String(accountId).toLowerCase() as AccountId)
  } catch {
    return false
  }
}

/**
 * True when nobody is allowlisted (the prod default, and the fail-closed
 * result of an unreadable allowlist). Lets the paused award hook return
 * before any Mongo query. Never throws.
 */
export const referralPayoutAllowlistIsEmpty = async (): Promise<boolean> => {
  try {
    return (await loadAllowlist()).size === 0
  } catch {
    return true
  }
}
