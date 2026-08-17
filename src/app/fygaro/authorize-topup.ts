import { FygaroConfig } from "@config"
import { AccountLevel } from "@domain/accounts"
import { baseLogger } from "@services/logger"
import { buildFygaroCheckout, type FygaroCheckout } from "@services/fygaro/checkout"
import { newIntentId, saveIntent } from "@services/fygaro/checkout-intent-store"
import { getFygaroSettings } from "@services/fygaro/webhook-server/fygaro-settings"
import { sumFygaroTopupGrossCentsLast24h } from "@services/frappe/BridgeTransferRequestWriter"

/**
 * Authorise a card top-up BEFORE the customer is sent to Fygaro.
 *
 * This is the half of the daily-limit story that was missing. The webhook has
 * always been able to refuse a credit, but by then Fygaro has captured the
 * card, so refusing leaves the customer charged and empty-handed (which is
 * exactly what happened to one account on 2026-08-16). Deciding here, before
 * the hand-off, is the only point at which "no" costs the customer nothing.
 *
 * The returned checkout URL carries a signed amount, so the answer given here
 * is the amount that can actually be paid.
 */

export type AuthorizeTopupFailure =
  | "checkout-disabled"
  | "settings-unavailable"
  | "below-minimum"
  | "above-single-payment-limit"
  | "no-daily-limit-for-level"
  | "history-unavailable"
  | "exceeds-daily-allowance"

export type AuthorizeTopupResult =
  | {
      authorized: true
      checkout: FygaroCheckout
      remainingAllowanceCents: number
    }
  | {
      authorized: false
      reason: AuthorizeTopupFailure
      // Present whenever we know it, so the client can say "$45 left today"
      // instead of a bare refusal. Undefined only when the allowance itself
      // could not be established.
      remainingAllowanceCents?: number
      limitCents?: number
      minimumCents?: number
    }

export const authorizeFygaroTopup = async ({
  accountId,
  username,
  level,
  amountCents,
  nowMs = Date.now(),
}: {
  accountId: string
  username: string
  level: AccountLevel
  amountCents: number
  nowMs?: number
}): Promise<AuthorizeTopupResult> => {
  const checkoutConfig = FygaroConfig.checkout
  if (!checkoutConfig?.enabled || !checkoutConfig.buttonUrl || !checkoutConfig.keyId) {
    return { authorized: false, reason: "checkout-disabled" }
  }

  const secret = FygaroConfig.webhook?.secrets?.[checkoutConfig.keyId]
  if (!secret) {
    // Misconfiguration, not a user error: the key id names a secret that is not
    // present. Fail as "disabled" so the caller degrades to the legacy flow
    // rather than showing the customer an error we caused.
    baseLogger.error(
      { keyId: checkoutConfig.keyId },
      "Fygaro checkout enabled but no signing secret for keyId",
    )
    return { authorized: false, reason: "checkout-disabled" }
  }

  // Returns undefined (never throws) when the ERPNext row is unreadable or
  // malformed — same "record-only" posture the webhook takes.
  const settings = await getFygaroSettings()
  if (!settings) {
    return { authorized: false, reason: "settings-unavailable" }
  }
  if (!settings.autoCreditEnabled) {
    // Nothing would be credited even on a clean payment, so authorising a
    // charge here would knowingly create another stuck top-up.
    return { authorized: false, reason: "checkout-disabled" }
  }

  const minimumCents = Math.round(settings.minimumTopup * 100)
  if (amountCents < minimumCents) {
    return { authorized: false, reason: "below-minimum", minimumCents }
  }

  // The single-payment auto-credit ceiling. Anything above it would be recorded
  // and held for manual review even if the daily allowance were untouched, so
  // there is no honest way to authorise it here.
  const singleLimitCents = Math.round(settings.autoCreditLimit * 100)
  if (amountCents > singleLimitCents) {
    return {
      authorized: false,
      reason: "above-single-payment-limit",
      limitCents: singleLimitCents,
    }
  }

  const dailyLimitUsd = settings.dailyTopupLimits[level]
  if (dailyLimitUsd === undefined) {
    return { authorized: false, reason: "no-daily-limit-for-level" }
  }
  const dailyLimitCents = Math.round(dailyLimitUsd * 100)

  // Same read the webhook gate uses, so the answer here and the decision there
  // cannot drift. `excludeTransactionId` has no counterpart yet — nothing has
  // been paid — so pass a value that matches no row.
  const priorCents = await sumFygaroTopupGrossCentsLast24h({
    accountId,
    excludeTransactionId: `intent-preauth-${accountId}`,
  })
  if (priorCents instanceof Error) {
    // Never coerce an unreadable history to zero: that would treat an ERPNext
    // outage as a clean slate and authorise the full allowance to everyone.
    return { authorized: false, reason: "history-unavailable" }
  }

  const remainingAllowanceCents = Math.max(0, dailyLimitCents - priorCents)
  if (amountCents > remainingAllowanceCents) {
    return {
      authorized: false,
      reason: "exceeds-daily-allowance",
      remainingAllowanceCents,
      limitCents: dailyLimitCents,
    }
  }

  const intentId = newIntentId()
  const checkout = buildFygaroCheckout({
    buttonUrl: checkoutConfig.buttonUrl,
    username,
    intentId,
    amountCents,
    currency: "USD",
    keyId: checkoutConfig.keyId,
    secret,
    ttlSeconds: checkoutConfig.ttlSeconds,
    nowMs,
  })

  const saved = await saveIntent({
    intent: {
      intentId,
      accountId,
      username,
      amountCents,
      currency: "USD",
      createdAtMs: nowMs,
    },
    ttlSeconds: checkoutConfig.ttlSeconds,
  })
  if (saved instanceof Error) {
    // The signed URL is still perfectly payable and the webhook gate still
    // applies; only our own after-the-fact cross-check is missing. Log it and
    // proceed rather than blocking a legitimate top-up on a cache write.
    baseLogger.warn(
      { intentId, error: saved.constructor.name },
      "Failed to persist Fygaro checkout intent; proceeding without cross-check",
    )
  }

  return {
    authorized: true,
    checkout,
    remainingAllowanceCents: remainingAllowanceCents - amountCents,
  }
}
