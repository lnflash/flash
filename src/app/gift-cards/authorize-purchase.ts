import { GiftCardsConfig } from "@config"

import { effectiveAccountLevel } from "@domain/accounts"
import {
  GiftCardLevelNotEligibleError,
  GiftCardLimitExceededError,
  GiftCardOrderStatus,
  GiftCardsDisabledError,
  UnknownGiftCardError,
} from "@domain/gift-cards"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { baseLogger } from "@services/logger"
import { GiftCardOrdersRepository } from "@services/mongoose"
import { addAttributesToCurrentSpan } from "@services/tracing"

import {
  readGiftCardReservations,
  releaseGiftCardReservation,
  writeGiftCardReservation,
} from "./reservation-store"

export { releaseGiftCardReservation }

/**
 * ENG-583 — limits and compliance for the gift-card spend rail.
 *
 * TBC's unverified-user limits ($1,000 open-loop / $2,000 closed-loop per
 * card, $10,000 per user per day) are what keep the product inside FinCEN's
 * prepaid-access exemption, and TBC puts the monitoring burden on the
 * reseller. Flash layers its own per-level caps underneath (perLevel.*), so
 * the effective cap is always `min(flash, vendor)`.
 *
 * Modes (`giftCards.limits.mode`), same rollout discipline as the ENG-573 send
 * guard: `off` skips every check; `log-only` runs them all, emits a
 * `giftcard / would-reject` ops event on failure and AUTHORISES anyway;
 * `enforce` refuses. A week of would-reject data is reviewed before the flip.
 *
 * Rejection reasons have exactly one source — this const — so the specs and
 * the would-reject census reference the same strings.
 */
export const GiftCardRejectionReasons = {
  levelNotEligible: "level-not-eligible",
  accountTooNew: "account-too-new",
  perCardCap: "per-card-cap",
  dailyCap: "daily-cap",
  vendorDailyCap: "vendor-daily-cap",
  vendorCardCap: "vendor-card-cap",
  velocity: "velocity",
  openLoopNotAllowed: "open-loop-not-allowed",
  limitsUnavailable: "limits-unavailable",
} as const

export type GiftCardRejectionReason =
  (typeof GiftCardRejectionReasons)[keyof typeof GiftCardRejectionReasons]

export type GiftCardAuthorization =
  | { authorized: true; reservationId: string | null }
  | { authorized: false; error: ApplicationError; reason: GiftCardRejectionReason }

type Rejection = { error: ApplicationError; reason: GiftCardRejectionReason }

export type AuthorizeGiftCardPurchaseArgs = {
  account: Pick<Account, "id" | "level" | "createdAt">
  product: Pick<GiftCardProduct, "id" | "isOpenLoop" | "currency">
  valueMinor: number
  quantity: number
  /** Injectable clock for the specs. */
  nowMs?: number
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// The trailing-24h window can only be summed from a bounded page. Anything
// past this many orders in a day is already far beyond every configured
// velocity (maxOrdersPerHour × 24 with the shipped defaults is 120), so a
// truncated page is treated as "cannot evaluate" rather than summed short.
const ORDER_PAGE_LIMIT = 200

// Orders that never moved money. EXPIRED included: an expired invoice was
// never paid. REFUND_REQUIRED deliberately NOT included — money left Flash.
const NON_SPEND_STATUSES: readonly GiftCardOrderStatus[] = [
  GiftCardOrderStatus.Failed,
  GiftCardOrderStatus.PaymentFailed,
  GiftCardOrderStatus.Expired,
]

const OPEN_LOOP_MIN_LEVEL = 2

const levelLimits = (level: number) => {
  const perLevel = GiftCardsConfig.limits.perLevel
  const key = `level${level}` as keyof typeof perLevel
  // A level the config does not name (future L4) inherits the top tier rather
  // than zero: a new tier must never silently lose an allowance it had.
  return perLevel[key] ?? perLevel.level3
}

const formatMinor = (minor: number, currency: string) =>
  `${(minor / 100).toFixed(2)} ${currency}`

const limitExceeded = (message: string, reason: GiftCardRejectionReason): Rejection => ({
  error: new GiftCardLimitExceededError(message),
  reason,
})

// The store we sum from (Mongo or Redis) could not be read. Critical-level so
// an outage of a limits dependency pages, rather than surfacing to customers
// as a "limit exceeded" they never hit.
const limitsUnavailable = (cause: Error): Rejection => ({
  error: new UnknownGiftCardError(
    `Could not verify gift card limits: ${cause.constructor.name}`,
  ),
  reason: GiftCardRejectionReasons.limitsUnavailable,
})

/**
 * Every check, in order, against the account's history and live holds.
 * Returns the first failure, or `true`. A repository/Redis fault is a
 * `limits-unavailable` rejection: what that means is decided by the mode.
 */
const evaluate = async ({
  account,
  product,
  valueMinor,
  quantity,
  nowMs,
}: Required<AuthorizeGiftCardPurchaseArgs>): Promise<true | Rejection> => {
  const limits = GiftCardsConfig.limits
  const level = effectiveAccountLevel(account.level)
  const totalMinor = valueMinor * quantity
  const currency = product.currency

  // 1. Level. Level 0 is refused regardless of config: a device-only account
  //    has no identity and no allowance to spend against.
  if (level === 0 || level < limits.minAccountLevel) {
    return {
      error: new GiftCardLevelNotEligibleError(),
      reason: GiftCardRejectionReasons.levelNotEligible,
    }
  }

  // 2. Account age (new-account cooldown).
  const ageHours = (nowMs - account.createdAt.getTime()) / HOUR_MS
  if (ageHours < limits.minAccountAgeHours) {
    return limitExceeded(
      `Gift cards unlock ${limits.minAccountAgeHours} hours after you join`,
      GiftCardRejectionReasons.accountTooNew,
    )
  }

  // 3. Open-loop (Visa/Mastercard-style) cards: the conversion-to-cash vector
  //    CUS-7 flags. Feature switch first, then the level floor.
  if (product.isOpenLoop) {
    if (!GiftCardsConfig.allowOpenLoop) {
      return {
        error: new GiftCardsDisabledError("Prepaid cards are not available right now"),
        reason: GiftCardRejectionReasons.openLoopNotAllowed,
      }
    }
    if (level < OPEN_LOOP_MIN_LEVEL) {
      return {
        error: new GiftCardLevelNotEligibleError(
          "Prepaid cards aren't available on your account level yet",
        ),
        reason: GiftCardRejectionReasons.openLoopNotAllowed,
      }
    }
  }

  // 4. Per-card cap: min(Flash per-level, vendor open/closed-loop).
  const perLevel = levelLimits(level)
  const vendorCardCap = product.isOpenLoop
    ? limits.vendorOpenLoopCardCapCents
    : limits.vendorClosedLoopCardCapCents
  if (totalMinor > perLevel.perCardCents) {
    return limitExceeded(
      `Gift card purchases are limited to ${formatMinor(perLevel.perCardCents, currency)} per order on your account level`,
      GiftCardRejectionReasons.perCardCap,
    )
  }
  if (totalMinor > vendorCardCap) {
    return limitExceeded(
      `Gift card purchases are limited to ${formatMinor(vendorCardCap, currency)} per order`,
      GiftCardRejectionReasons.vendorCardCap,
    )
  }

  // 5 + 6. Velocity and daily cap share one page of recent orders.
  const recent = await GiftCardOrdersRepository().listByAccount({
    accountId: account.id,
    limit: ORDER_PAGE_LIMIT,
  })
  if (recent instanceof Error) return limitsUnavailable(recent)

  const windowStart = nowMs - DAY_MS
  const inWindow = recent.filter((o) => o.createdAt.getTime() >= windowStart)
  if (recent.length >= ORDER_PAGE_LIMIT && inWindow.length === recent.length) {
    // The page is full and every row is inside the window: the window is
    // truncated and the sum would be short. Refuse to guess.
    return limitsUnavailable(new Error("TruncatedOrderWindow"))
  }

  const hourStart = nowMs - HOUR_MS
  const lastHour = inWindow.filter((o) => o.createdAt.getTime() >= hourStart).length
  if (lastHour >= limits.maxOrdersPerHour) {
    return limitExceeded(
      "Too many gift card orders in the last hour; please try again later",
      GiftCardRejectionReasons.velocity,
    )
  }

  const spentMinor = inWindow
    .filter((o) => !NON_SPEND_STATUSES.includes(o.status))
    .reduce((sum, o) => sum + o.valueMinor * o.quantity, 0)

  const reservations = await readGiftCardReservations({ accountId: account.id, nowMs })
  if (reservations instanceof Error) return limitsUnavailable(reservations)
  const heldMinor = reservations.reduce((sum, r) => sum + r.amountMinor, 0)

  const projected = spentMinor + heldMinor + totalMinor
  if (projected > perLevel.dailyCents) {
    return limitExceeded(
      `Gift card purchases are limited to ${formatMinor(perLevel.dailyCents, currency)} per day on your account level`,
      GiftCardRejectionReasons.dailyCap,
    )
  }
  if (projected > limits.vendorDailyCapCents) {
    return limitExceeded(
      `Gift card purchases are limited to ${formatMinor(limits.vendorDailyCapCents, currency)} per day`,
      GiftCardRejectionReasons.vendorDailyCap,
    )
  }

  return true
}

const reportWouldReject = ({
  account,
  product,
  totalMinor,
  rejection,
  mode,
}: {
  account: Pick<Account, "id" | "level">
  product: Pick<GiftCardProduct, "id" | "currency">
  totalMinor: number
  rejection: Rejection
  mode: GiftCardLimitsMode
}) => {
  const level = String(effectiveAccountLevel(account.level))
  addAttributesToCurrentSpan({
    "giftcard.limits.mode": mode,
    "giftcard.limits.reason": rejection.reason,
    "giftcard.limits.error": rejection.error.constructor.name,
  })
  notifyOpsEvent({
    flow: "giftcard",
    phase: mode === "enforce" ? "rejected" : "would-reject",
    status: mode === "enforce" ? "failed" : "pending",
    accountId: account.id,
    amount: { value: (totalMinor / 100).toFixed(2), currency: product.currency },
    error: rejection.error.constructor.name,
    meta: { reason: rejection.reason, level, productId: product.id },
  })
}

/**
 * Decide whether this account may buy this card right now, and if so hold the
 * amount against its daily allowance until the order row exists.
 *
 * `reservationId` is null only in `off` mode (nothing was evaluated, nothing is
 * held) or when the hold could not be written in log-only (logged, allowed).
 */
export const authorizeGiftCardPurchase = async (
  args: AuthorizeGiftCardPurchaseArgs,
): Promise<GiftCardAuthorization> => {
  const mode = GiftCardsConfig.limits.mode
  if (mode === "off") return { authorized: true, reservationId: null }

  const nowMs = args.nowMs ?? Date.now()
  const totalMinor = args.valueMinor * args.quantity

  const outcome = await evaluate({ ...args, nowMs })

  if (outcome !== true) {
    reportWouldReject({
      account: args.account,
      product: args.product,
      totalMinor,
      rejection: outcome,
      mode,
    })
    if (mode === "enforce") return { authorized: false, ...outcome }
    baseLogger.info(
      {
        accountId: args.account.id,
        productId: args.product.id,
        reason: outcome.reason,
        mode,
      },
      "Gift card limits would reject; allowing in log-only mode",
    )
  }

  const reservationId = await writeGiftCardReservation({
    accountId: args.account.id,
    amountMinor: totalMinor,
    nowMs,
  })
  if (reservationId instanceof Error) {
    const rejection = limitsUnavailable(reservationId)
    if (mode === "enforce") {
      reportWouldReject({
        account: args.account,
        product: args.product,
        totalMinor,
        rejection,
        mode,
      })
      return { authorized: false, ...rejection }
    }
    baseLogger.warn(
      { accountId: args.account.id, error: reservationId.constructor.name },
      "Could not write gift card reservation; allowing in log-only mode",
    )
    return { authorized: true, reservationId: null }
  }

  return { authorized: true, reservationId }
}
