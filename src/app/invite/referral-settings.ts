/**
 * Cached reader for the ERPNext "Referral Settings" Single doctype — the
 * operator kill switch for referral reward payouts (requested after the
 * 2026-09-01 referral-farming wave: 87 fresh accounts, 288 invites in a day).
 *
 * Polarity is the whole design: a payout may proceed ONLY on an affirmative,
 * readable `rewards_enabled = 1`. "Disabled", "unreadable", "missing", and
 * "malformed" all mean the same thing — DO NOT PAY. The caller defers by
 * returning before the reward claim, so nothing is marked failed and nothing
 * is lost: the invite stays ACCEPTED + unrewarded and pays on a later trigger
 * once the switch is back on. That makes fail-closed safe here in a way it
 * would not be if deferral were destructive.
 *
 * Memoised for ~60s (successes AND failures, same as the Fygaro settings
 * reader) so a KYC-approval burst cannot become an ERPNext fetch storm, while
 * an operator flip still takes effect within a minute.
 */
import { toBoolean } from "@services/frappe/coerce"
import ErpNext from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"

const CACHE_TTL_MS = 60_000

let cache: { enabled: boolean; at: number } | undefined

export const resetReferralSettingsCache = () => {
  cache = undefined
}

/** True only on an affirmative, readable rewards_enabled=1. */
export const referralRewardsEnabledInErp = async (): Promise<boolean> => {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.enabled

  const doc = ErpNext?.getReferralSettings
    ? await ErpNext.getReferralSettings()
    : undefined

  let enabled = false
  if (doc instanceof Error || doc === undefined) {
    baseLogger.warn(
      { error: doc },
      "Referral Settings unreadable — treating reward payouts as DISABLED (deferred)",
    )
  } else {
    enabled = toBoolean(doc.rewards_enabled)
  }

  cache = { enabled, at: now }
  return enabled
}
