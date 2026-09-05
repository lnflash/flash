import { getAccountLimits } from "@config"

import { usdFromBtcMidPriceFn } from "@app/prices/mid-price"

import { AccountLevel } from "@domain/accounts"
import {
  IntraledgerLimitsExceededError,
  WithdrawalLimitsExceededError,
} from "@domain/errors"
import {
  InvalidSendAmountError,
  SendLimitsUnavailableError,
} from "@domain/payments/errors"
import { RateLimitConfig } from "@domain/rate-limit"
import { WalletCurrency } from "@domain/shared"

import { notifyOpsEvent } from "@services/alerts/ops-events"
import { consumeLimiter } from "@services/rate-limit"

/**
 * ENG-573 Phase 0 — the send guard.
 *
 * Every user-initiated send mutation calls this before anything reaches IBEX.
 * Flash has no internal ledger, so Galoy's `AccountLimitsChecker` reads a
 * volume of zero for every account and never rejects; until the Phase 1
 * allowance counter exists this is the only Flash-side check on a send.
 *
 * Checks, in order:
 *   1. attempt budget  — two Redis buckets keyed on the account (burst + daily).
 *      Consumed FIRST so that a rejected attempt still costs a point: a caller
 *      probing the amount space is bounded by their own budget.
 *   2. amount sanity   — positive and finite. USD/USDT cents may be fractional
 *      (USDT settles in micros); sats must be whole.
 *   3. daily limit     — `amount <= dailyLimit(level)`. Per the ENG-573 decision
 *      the daily limit *is* the per-transaction cap; Phase 1 tightens this to
 *      the remaining allowance. Intraledger sends use the intraLedger limit,
 *      everything that leaves Flash uses the withdrawal limit.
 *
 * Fails closed: no limit configured for the level, or no BTC→USD price when
 * the amount is in sats, rejects the send with `SendLimitsUnavailableError`.
 *
 * Every rejection is posted to the ops feed as `transfer / rejected`, so a
 * wall-of-nines probe shows up with the account attached instead of as an
 * anonymous IbexError.
 *
 * Not applied to system credits (rewards, referral payouts, top-up credits,
 * reimbursements): those call the `@app` layer directly and never pass
 * through a send mutation.
 */

export type SendKind = "intraledger" | "lightning" | "lnurl" | "onchain"

export type SendAmountInput =
  // Cents may arrive as a string: the FractionalCentAmount scalar is typed as a
  // branded string even though it parses to a float at runtime.
  | { currency: "USD"; cents: number | bigint | string }
  | { currency: "BTC"; sats: number | bigint }

export type SendRejectionReason =
  | "rate-limited"
  | "invalid-amount"
  | "over-daily-limit"
  | "limits-unavailable"

type AuthorizeSendArgs = {
  senderAccount: Account
  senderWalletId: WalletId
  amount: SendAmountInput
  kind: SendKind
}

// Rejection reasons the guard attaches to the ops event, kept as a value so
// tests and the Phase 1 counter can reference them without retyping strings.
export const SendRejectionReasons = {
  rateLimited: "rate-limited",
  invalidAmount: "invalid-amount",
  overDailyLimit: "over-daily-limit",
  limitsUnavailable: "limits-unavailable",
} as const

const usdDisplay = (cents: number) => ({
  value: (cents / 100).toFixed(2),
  currency: "USD",
})

// An account document with no `level` field hydrates as `undefined` (the
// mongoose schema has no default; ~300 prod accounts are in this state). An
// unleveled account is an unverified one, so it gets the level-0 limits rather
// than a closed door.
const effectiveLevel = (account: Account): AccountLevel =>
  account.level ?? AccountLevel.Zero

const toPositiveNumber = (
  raw: number | bigint | string,
  { integer }: { integer: boolean },
): number | InvalidSendAmountError => {
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    return new InvalidSendAmountError("Amount must be greater than zero")
  }
  if (integer && !Number.isInteger(value)) {
    return new InvalidSendAmountError("Amount must be a whole number")
  }
  return value
}

const usdCentsFromSendAmount = async (
  amount: SendAmountInput,
): Promise<
  | { cents: number; reason?: undefined }
  | { error: ApplicationError; reason: SendRejectionReason }
> => {
  if (amount.currency === "USD") {
    const cents = toPositiveNumber(amount.cents, { integer: false })
    if (cents instanceof Error) return { error: cents, reason: "invalid-amount" }
    return { cents }
  }

  const sats = toPositiveNumber(amount.sats, { integer: true })
  if (sats instanceof Error) return { error: sats, reason: "invalid-amount" }

  const usd = await usdFromBtcMidPriceFn({
    amount: BigInt(sats),
    currency: WalletCurrency.Btc,
  })
  if (usd instanceof Error) {
    return {
      error: new SendLimitsUnavailableError(`BTC→USD price unavailable: ${usd.message}`),
      reason: "limits-unavailable",
    }
  }
  return { cents: Number(usd.amount) }
}

export const authorizeSend = async ({
  senderAccount,
  senderWalletId,
  amount,
  kind,
}: AuthorizeSendArgs): Promise<true | ApplicationError> => {
  const level = effectiveLevel(senderAccount)

  const reject = <E extends ApplicationError>(
    error: E,
    reason: SendRejectionReason,
    cents?: number,
  ): E => {
    notifyOpsEvent({
      flow: "transfer",
      phase: "rejected",
      status: "failed",
      accountId: senderAccount.id,
      amount: cents === undefined ? undefined : usdDisplay(cents),
      error: error.constructor.name,
      meta: { senderWalletId, kind, reason, level: String(level) },
    })
    return error
  }

  // 1. attempt budget — every attempt costs a point, rejected ones included
  for (const rateLimitConfig of [
    RateLimitConfig.paymentSend,
    RateLimitConfig.paymentSendDaily,
  ]) {
    const budget = await consumeLimiter({
      rateLimitConfig,
      keyToConsume: senderAccount.id,
    })
    if (budget instanceof Error) return reject(budget, "rate-limited")
  }

  // 2. amount sanity + normalisation to USD cents
  const normalised = await usdCentsFromSendAmount(amount)
  if (normalised.reason !== undefined) return reject(normalised.error, normalised.reason)
  const { cents } = normalised

  // 3. daily limit for the level doubles as the per-transaction cap (Phase 0)
  const limits = getAccountLimits({ level })
  const limit = kind === "intraledger" ? limits.intraLedgerLimit : limits.withdrawalLimit
  if (!Number.isFinite(limit)) {
    return reject(
      new SendLimitsUnavailableError(`no daily send limit configured for level ${level}`),
      "limits-unavailable",
      cents,
    )
  }
  if (cents > limit) {
    const limitAsUsd = `$${(limit / 100).toFixed(2)}`
    const message = `Cannot transfer more than ${limitAsUsd} in 24 hours`
    const error =
      kind === "intraledger"
        ? new IntraledgerLimitsExceededError(message)
        : new WithdrawalLimitsExceededError(message)
    return reject(error, "over-daily-limit", cents)
  }

  return true
}
