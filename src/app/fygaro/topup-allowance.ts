import { AccountLevel } from "@domain/accounts"
import { readFygaroTopupWindowLast24h } from "@services/frappe/BridgeTransferRequestWriter"
import { getFygaroSettings } from "@services/fygaro/webhook-server/fygaro-settings"

/**
 * How much of today's card top-up allowance is left for one account.
 *
 * The app has only ever known the FLAT per-level cap, which is why one account
 * paid $100, $80 and $60 against a $125 cap on 2026-08-16 without the client
 * objecting once: each amount is individually under the cap, and nothing on the
 * device knew what had already been spent. This is the missing half.
 *
 * Read-only and side-effect free, unlike `authorizeFygaroTopup` — it can be
 * called while the customer is still typing an amount, where minting a
 * reservation would burn their allowance on a number they never committed to.
 */

export type FygaroTopupAllowance = {
  limitCents: number
  // Settled + in-flight gross over the trailing 24h. Payments we captured but
  // refused are excluded: they delivered no value, so they must not consume the
  // allowance that governs value delivered.
  spentCents: number
  remainingCents: number
  // When the oldest counted payment ages out of the window and some allowance
  // comes back. Undefined when nothing is counted (the full cap is available).
  // This is the only actionable thing to tell someone who has been refused.
  resetsAt?: Date
}

export type FygaroTopupAllowanceFailure =
  | "settings-unavailable"
  | "history-unavailable"
  | "no-daily-limit-for-level"

export type FygaroTopupAllowanceResult =
  | { available: true; allowance: FygaroTopupAllowance }
  | { available: false; reason: FygaroTopupAllowanceFailure }

const DAY_MS = 24 * 60 * 60 * 1000

export const getFygaroTopupAllowance = async ({
  accountId,
  level,
}: {
  accountId: string
  level: AccountLevel
}): Promise<FygaroTopupAllowanceResult> => {
  // Returns undefined (never throws) when the ERPNext row is unreadable.
  const settings = await getFygaroSettings()
  if (!settings) return { available: false, reason: "settings-unavailable" }

  const dailyLimitUsd = settings.dailyTopupLimits[level]
  if (dailyLimitUsd === undefined) {
    // A level with no configured cap cannot top up at all. Deterministic, and
    // deliberately distinct from the transient failures either side of it.
    return { available: false, reason: "no-daily-limit-for-level" }
  }
  const limitCents = Math.round(dailyLimitUsd * 100)

  const window = await readFygaroTopupWindowLast24h({ accountId })
  if (window instanceof Error) {
    // Never coerce an unreadable history to zero spend: that would show every
    // customer their full allowance for the duration of an ERPNext outage, and
    // then refuse the payment they were just invited to make.
    return { available: false, reason: "history-unavailable" }
  }

  return {
    available: true,
    allowance: {
      limitCents,
      spentCents: window.grossCents,
      remainingCents: Math.max(0, limitCents - window.grossCents),
      resetsAt:
        window.oldestCountedMs === undefined
          ? undefined
          : new Date(window.oldestCountedMs + DAY_MS),
    },
  }
}
