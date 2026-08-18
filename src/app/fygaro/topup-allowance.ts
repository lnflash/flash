import { FygaroConfig } from "@config"
import { AccountLevel } from "@domain/accounts"
import { readFygaroTopupWindowLast24h } from "@services/frappe/BridgeTransferRequestWriter"
import { readOutstandingReservations } from "@services/fygaro/checkout-intent-store"
import { getFygaroSettings } from "@services/fygaro/webhook-server/fygaro-settings"

/**
 * How much of today's card top-up allowance is left for one account.
 *
 * The app has only ever known the FLAT per-level cap, which is why one account
 * paid $100, $80 and $60 against a $125 cap on 2026-08-16 without the client
 * objecting once: each amount is individually under the cap, and nothing on the
 * device knew what had already been spent. This is the missing half.
 *
 * Does not mint a reservation, unlike `authorizeFygaroTopup`, so it is safe to
 * call while the customer is still typing an amount — where minting one would
 * burn their allowance on a number they never committed to. It is NOT literally
 * side-effect free: reading the hold index prunes the entries that have expired
 * (`readOutstandingReservations` issues a ZREMRANGEBYSCORE before it reads).
 *
 * It must nonetheless answer with the SAME arithmetic and the SAME gates as
 * `authorizeFygaroTopup`, or it invites a top-up the pre-charge check then
 * refuses — the invite-then-refuse failure this workstream exists to end, moved
 * onto a new surface. Two things follow from that and neither is optional: the
 * master switches are checked here too, and live holds are subtracted here too.
 */

export type FygaroTopupAllowance = {
  limitCents: number
  // Settled + in-flight gross over the trailing 24h. Payments we captured but
  // refused are excluded: they delivered no value, so they must not consume the
  // allowance that governs value delivered.
  spentCents: number
  // Unpaid checkout links this account is still holding. NOT spent — nothing
  // has been charged — but not available either, because paying one of them
  // would charge it. Kept separate from `spentCents` precisely because "you
  // have spent $0 and have $65 left of $125" is the true sentence, and folding
  // holds into spend would make it a false one.
  heldCents: number
  // What would still be accepted right now: the cap less BOTH the settled gross
  // and the live holds — the same quantity `authorizeFygaroTopup` computes, so
  // the two surfaces cannot disagree about the same account at the same moment.
  remainingCents: number
  // When the oldest counted payment ages out of the window and some allowance
  // comes back. Undefined when nothing is counted (the full cap is available).
  // SETTLED SPEND ONLY: it is derived from the ERPNext window, and holds live in
  // Redis, so it says nothing at all about when a hold lifts. That is what
  // `holdsExpireAt` is for, and the two are reported separately because they
  // come back at different times for different reasons.
  resetsAt?: Date
  // When the SOONEST of this account's unpaid checkout links expires and its
  // hold on the allowance lifts by itself. Undefined when nothing is held.
  // Without it, an account whose whole gap is holds is told "$0 spent, $65 of
  // $125 available" with no way to explain the missing $60 or say when it
  // returns — the exact dead end a refusal with no reset time is.
  holdsExpireAt?: Date
}

export type FygaroTopupAllowanceFailure =
  // Card top-ups are off at the deploy level, or auto-credit is off in the
  // operator settings. There is no allowance to report because there is nothing
  // it could be spent on — `authorizeFygaroTopup` refuses every request with
  // `checkout-disabled` in this state.
  | "checkout-disabled"
  | "settings-unavailable"
  | "history-unavailable"
  // The reservation index (Redis) was unreadable. Named separately from
  // `history-unavailable` so an operator reading it goes to Redis, not ERPNext.
  | "reservations-unavailable"
  | "no-daily-limit-for-level"

export type FygaroTopupAllowanceResult =
  | { available: true; allowance: FygaroTopupAllowance }
  | { available: false; reason: FygaroTopupAllowanceFailure }

const DAY_MS = 24 * 60 * 60 * 1000

export const getFygaroTopupAllowance = async ({
  accountId,
  level,
  nowMs = Date.now(),
}: {
  accountId: string
  level: AccountLevel
  nowMs?: number
}): Promise<FygaroTopupAllowanceResult> => {
  // The yaml master gates, first and before any read — the same order
  // `authorizeFygaroTopup` applies them in. With `fygaro.enabled` off the
  // webhook 503s every delivery (a payment would not even be RECORDED), and
  // with `credit.enabled` off it records without crediting. Reporting a healthy
  // allowance in either state invites a charge that cannot be credited.
  if (!FygaroConfig?.enabled || !FygaroConfig?.credit?.enabled) {
    return { available: false, reason: "checkout-disabled" }
  }

  // Returns undefined (never throws) when the ERPNext row is unreadable.
  const settings = await getFygaroSettings()
  if (!settings) return { available: false, reason: "settings-unavailable" }

  // The operator kill switch. Same argument as the deploy gate above: with it
  // off, every checkout request is refused `checkout-disabled`, so a number
  // here would be a number that cannot be spent.
  if (!settings.autoCreditEnabled) {
    return { available: false, reason: "checkout-disabled" }
  }

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

  // Links this account authorised and has not paid are still payable, so they
  // are subtracted here exactly as `authorizeFygaroTopup` subtracts them. The
  // canonical case is the customer who minted a $60 link and closed the page:
  // without this, they are shown the full $125, enter $125, and are refused —
  // the invite-then-refuse loop, rebuilt on the query the PR added to end it.
  const reservations = await readOutstandingReservations({ accountId, nowMs })
  if (reservations instanceof Error) {
    // Fail closed, matching the gate (authorize-topup refuses
    // `reservations-unavailable` rather than treating unknown holds as none).
    return { available: false, reason: "reservations-unavailable" }
  }
  const heldCents = reservations.reduce((sum, r) => sum + r.amountCents, 0)
  // The SOONEST expiry, not the latest: it is the first moment any of this
  // allowance comes back on its own, which is the only thing worth telling
  // someone who is looking at a number smaller than they expected.
  const soonestHoldExpiryMs = reservations.reduce<number | undefined>(
    (soonest, r) =>
      soonest === undefined ? r.expiresAtMs : Math.min(soonest, r.expiresAtMs),
    undefined,
  )

  return {
    available: true,
    allowance: {
      limitCents,
      spentCents: window.grossCents,
      heldCents,
      remainingCents: Math.max(0, limitCents - window.grossCents - heldCents),
      resetsAt:
        window.oldestCountedMs === undefined
          ? undefined
          : new Date(window.oldestCountedMs + DAY_MS),
      holdsExpireAt:
        soonestHoldExpiryMs === undefined ? undefined : new Date(soonestHoldExpiryMs),
    },
  }
}
