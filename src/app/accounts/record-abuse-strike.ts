import { getAbuseAutoLockMode, getAbuseStrikeLimits } from "@config"

import { AccountStatus } from "@domain/accounts/primitives"
import { RateLimitPrefix } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { ErrorLevel } from "@domain/shared"

import { notifyOpsEvent } from "@services/alerts/ops-events"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import { ApiKeysRepository } from "@services/mongoose/api-keys"
import { RedisRateLimitService } from "@services/rate-limit"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import { updateAccountStatus } from "./update-account-status"

/**
 * Abuse auto-lock.
 *
 * A STRIKE is a request the Flash apps cannot produce: only a hand-written
 * client sends it, so it says something about the caller and nothing about a
 * confused user. Today there is one source, a send with an invalid amount
 * (zero, negative, non-finite, fractional sats) refused by the send guard. Add
 * a source by calling `recordAbuseStrike` from the place that refuses the
 * request, and by adding its name to `AbuseStrikeReasons`. Do NOT add anything
 * a real user can trigger by mistake (a wrong PIN, an over-limit amount, a
 * mistyped address): the outcome here is a locked account.
 *
 * Strikes are counted per account in Redis (`rateLimits.abuseStrike`; the
 * default tolerates one an hour, so the second locks). Crossing the threshold:
 *
 *   off       nothing is counted.
 *   log-only  DEFAULT. Posts a `would-auto-lock` ops event. Nothing is locked.
 *   enforce   locks the account with a comment that starts with
 *             `AUTO_LOCK_COMMENT_PREFIX` (what a reviewer searches for),
 *             revokes its API keys, and posts an `auto-locked` ops event.
 *
 * Unlocking is a person's decision, through the admin panel as for any lock.
 *
 * Never throws and never returns an error: callers fire it and move on, and a
 * Redis or Mongo fault here must not change the outcome of the request that
 * earned the strike. A fault is recorded on the span instead.
 */

export const AbuseStrikeReasons = {
  invalidSendAmount: "invalid-send-amount",
} as const

export type AbuseStrikeReason =
  (typeof AbuseStrikeReasons)[keyof typeof AbuseStrikeReasons]

export const AUTO_LOCK_COMMENT_PREFIX = "auto-lock:"

export type AbuseStrikeOutcome =
  | "off"
  | "counted"
  | "would-lock"
  | "locked"
  | "already-inactive"
  | "failed"

const fault = (error: Error, accountId: AccountId, step: string): "failed" => {
  recordExceptionInCurrentSpan({
    error,
    level: ErrorLevel.Critical,
    fallbackMsg: "abuse auto-lock could not complete",
    attributes: { "abuseAutoLock.accountId": accountId, "abuseAutoLock.step": step },
  })
  baseLogger.error({ error, accountId, step }, "abuse auto-lock could not complete")
  return "failed"
}

export const recordAbuseStrike = async ({
  accountId,
  reason,
}: {
  accountId: AccountId
  reason: AbuseStrikeReason
}): Promise<AbuseStrikeOutcome> => {
  const mode = getAbuseAutoLockMode()
  if (mode === "off") return "off"

  try {
    const strike = await RedisRateLimitService({
      keyPrefix: RateLimitPrefix.abuseStrike,
      limitOptions: getAbuseStrikeLimits(),
    }).consume(accountId)

    if (strike === true) return "counted"
    if (!(strike instanceof RateLimiterExceededError)) {
      return fault(strike, accountId, "count")
    }

    if (mode !== "enforce") {
      notifyOpsEvent({
        flow: "customer",
        phase: "would-auto-lock",
        status: "pending",
        accountId,
        step: reason,
        meta: { mode },
      })
      return "would-lock"
    }

    // Read the account fresh: the caller's copy predates this request, and a
    // burst of strikes must not stack one status entry per request.
    const account = await AccountsRepository().findById(accountId)
    if (account instanceof Error) return fault(account, accountId, "find")
    if (account.status !== AccountStatus.Active) return "already-inactive"

    const locked = await updateAccountStatus({
      id: accountId,
      status: AccountStatus.Locked,
      comment: `${AUTO_LOCK_COMMENT_PREFIX} repeated ${reason}; review before unlocking`,
    })
    if (locked instanceof Error) return fault(locked, accountId, "lock")

    // verifyApiKey already refuses a locked account's keys. Revoking them as
    // well means an unlock does not hand a prober its keys back.
    const revoked = await ApiKeysRepository().revokeAll(accountId)
    if (revoked instanceof Error) fault(revoked, accountId, "revoke-keys")

    notifyOpsEvent({
      flow: "customer",
      phase: "auto-locked",
      status: "failed",
      accountId,
      step: reason,
      meta: {
        mode,
        apiKeysRevoked: revoked instanceof Error ? "failed" : String(revoked),
      },
    })
    return "locked"
  } catch (err) {
    return fault(
      err instanceof Error ? err : new Error(String(err)),
      accountId,
      "unexpected",
    )
  }
}
