import { PaymentSplitsConfig } from "@config"

import { sendOutcomeNotificationBestEffort } from "@app/notifications/send-outcome-notification"
import { isDefinitivePaymentRejection as isDefinitivePaymentRejectionIbex } from "@app/payments/mark-outgoing-invoice"

import { AccountValidator } from "@domain/accounts"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { CouldNotFindError, InactiveAccountError } from "@domain/errors"
import { splitRetryBackoffMs } from "@domain/payment-splits"
import { WalletCurrency } from "@domain/shared"

import { notifyOpsEvent } from "@services/alerts/ops-events"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { isInternalTransferInvoice } from "@services/mongoose/internal-transfer-invoices"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import {
  PaymentSplitExecutionsRepository,
  type PaymentSplitExecutionRecord,
} from "@services/mongoose/payment-split-executions"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"

import { paySplitLeg } from "./internal-transfer"

const logger = baseLogger.child({ module: "payment-splits" })
export const PAYMENT_SPLIT_MEMO = "Payment split"

// The NET leg memo carries the gross and the payer's context: the merchant's
// IBEX history shows one +net from the shadow, and this line is what makes it
// auditable (ENG-717 decision 3 — history = net + memo in v2).
const NET_MEMO_PREFIX = "Payment received"

type SendProgress = {
  // Set once paySplitLeg reached IBEX payInvoice. Before that only addInvoice
  // and the marker write ran, and neither moves money.
  payInvoiceReached?: boolean
}

/**
 * Errors worth another attempt: raised before IBEX paid anything and expected
 * to clear on their own (an IBEX 429, the internal-transfer marker write, or
 * any IBEX error from minting the recipient invoice that is not a definitive
 * 4xx). Everything else is terminal on the first attempt, so an error whose
 * payment outcome is unknown is never re-sent.
 *
 * Unlike v1 there is no send-guard/authorize stage: split legs are exempt
 * from the merchant's send limits and KYC (ENG-717 decision 1), and the
 * sender is the shadow (no Flash account, no rate-limit key). That removes
 * the lock-error cases v1 had to reason about: withPaymentIdempotency is not
 * used on this path (its 24 h cache cannot replay a mid-send crash anyway —
 * see the stale sweep), so there is no idempotency lock to fail.
 */
export const isRetryableSplitError = (error: Error): boolean => {
  if (error instanceof IbexError) {
    if (error.httpCode === 429) return true
    // Non-definitive IBEX errors are retryable wherever they came from: an
    // addInvoice error moved nothing, and a payInvoice one is caught earlier
    // by isAmbiguousSplitSendError (which takes precedence in executeOne).
    return !isDefinitivePaymentRejectionIbex(error)
  }
  // Only meaningful pre-pay (the marker is written before payInvoice): a
  // marker error after the pay reached is ambiguous first.
  return error.name === "InternalTransferMarkerError"
}

/**
 * An error the send may have paid through: once the send reached IBEX
 * payInvoice, any IBEX error that is not a definitive rejection (a transport
 * error, a timeout, a 5xx — IBEX may already have debited the shadow).
 * Treated like a row the stale sweep finds stuck in `sending`: `unknown` plus
 * an ops alert, never resent.
 */
export const isAmbiguousSplitSendError = (
  error: Error,
  { payInvoiceReached = false }: SendProgress,
): boolean =>
  payInvoiceReached &&
  error instanceof IbexError &&
  !isDefinitivePaymentRejectionIbex(error)

const formatCents = (cents: number): string => `US$${(cents / 100).toFixed(2)}`

const notifyOwner = async (
  accountId: string,
  outcome: "failed" | "disabled",
  execution: PaymentSplitExecutionRecord,
): Promise<void> =>
  sendOutcomeNotificationBestEffort({
    accountId,
    phraseBase: `notification.paymentSplit.${outcome}`,
    dataType: `payment_split_${outcome}`,
    amountArg: formatCents(execution.shareCents),
    extraData: {
      amount: (execution.shareCents / 100).toFixed(2),
      currency: "USD",
      walletId: execution.walletId,
    },
  })

/**
 * ENG-660 carry-over: whether the split's DESTINATION account is inactive
 * right now. InactiveAccountError from the send does not say which side was
 * inactive (the shadow is checked first by IBEX), so the destination is
 * looked up directly. A lookup failure answers false: the row then fails as
 * before and the rule stays enabled.
 */
const isDestinationInactive = async (destinationWalletId: string): Promise<boolean> => {
  const wallet = await WalletsRepository().findById(destinationWalletId as WalletId)
  if (wallet instanceof Error) return false
  const account = await AccountsRepository().findById(wallet.accountId)
  if (account instanceof Error) return false
  return AccountValidator(account).isActive() instanceof Error
}

type ExecuteOutcome = "sent" | "ibex_pending" | "failed" | "retry" | "unknown" | "folded"

const executeOne = async (
  execution: PaymentSplitExecutionRecord,
  now: Date,
  stamp: () => Date,
): Promise<ExecuteOutcome> => {
  const executions = PaymentSplitExecutionsRepository()
  const attempts = execution.attempts + 1
  // The merchant's account id, resolved below and used by the fold/notify
  // paths. Undefined only while the lookups are still pending — the fold is
  // never reachable before them.
  let ownerAccountId: string | undefined = undefined

  // Records the outcome stamped with wall-clock time (not the pass's `now`),
  // so updatedAt reflects when the row actually finished. A false result means
  // the row was no longer `sending`: the stale sweep took it (marked it
  // `unknown` and alerted ops) while this send ran, so the outcome below is
  // the only record of what really happened.
  const finish = async (
    update: Omit<Parameters<typeof executions.finishClaimed>[1], "now">,
  ): Promise<void> => {
    const finished = await executions.finishClaimed(execution.id, {
      ...update,
      now: stamp(),
    })
    if (finished === true) return
    logger.error(
      {
        executionId: execution.id,
        walletId: execution.walletId,
        destinationWalletId: execution.destinationWalletId,
        outcome: update.status,
        lastError: update.lastError,
        error: finished instanceof Error ? finished : undefined,
      },
      finished instanceof Error
        ? "payment split outcome could not be recorded; the row stays in sending and the stale sweep will mark it unknown — resolve by hand with this outcome"
        : "payment split outcome lost: the row was no longer sending (the stale sweep took it); resolve the unknown row by hand with this outcome",
    )
  }

  // Decision 2 (fold, never fail): a terminal failure on a SHARE leg moves
  // the share back into the net leg. The fold is a second payout from the
  // shadow to the merchant for shareCents more — the net row was inserted at
  // settle with gross − Σ shares, so the fold row tops the merchant up to the
  // full gross. Insert FIRST, notify after: the push promises the money is
  // accounted for, and it is only true once the fold row exists.
  const foldShareToNet = async (
    reason: string,
    pushOwner?: "disabled" | "failed",
  ): Promise<ExecuteOutcome> => {
    if (!ownerAccountId) {
      // Unreachable per the control flow below (every fold call site follows
      // the account lookup); type-narrow, never cast.
      return fail(new Error("fold requested before account resolution"))
    }
    const folded = await executions.insertFold(execution, reason, stamp())
    if (folded instanceof Error) {
      logger.error(
        { executionId: execution.id, error: folded },
        "could not fold a failed share into the net leg; the share stays failed for ops",
      )
      // The share row is already terminal `failed`; the money stays in the
      // shadow and the reconcile's residual alert catches it. Page, not just
      // log: nobody was folding when v1's settle-and-forward had this case.
      notifyOpsEvent({
        flow: "transfer",
        phase: "split-fold-failed",
        status: "failed",
        amount: { value: (execution.shareCents / 100).toFixed(2), currency: "USD" },
        meta: {
          executionId: execution.id,
          walletId: execution.walletId,
          destinationWalletId: execution.destinationWalletId,
          reason,
        },
      })
      return "failed"
    }
    if (pushOwner) await notifyOwner(ownerAccountId, pushOwner, execution)
    return "folded"
  }

  const fail = async (error: Error | string, accountId?: string) => {
    const lastError = typeof error === "string" ? error : error.name || error.message
    await finish({ status: "failed", attempts, lastError })
    if (!accountId) return "failed" as const
    if (execution.legKind === "share") {
      return foldShareToNet(lastError, "failed")
    }
    await notifyOwner(accountId, "failed", execution)
    return "failed" as const
  }

  // ENG-660 carry-over: the destination account is no longer active, so every
  // later payout to it would fail the same way. Turn off the wallet's rules to
  // that destination and tell the owner once (only the call that flipped
  // `enabled` notifies). The share itself folds to the merchant.
  const failAndDisableRule = async (error: Error) => {
    await finish({ status: "failed", attempts, lastError: error.name })
    const rules = PaymentSplitRulesRepository()
    const logContext = {
      executionId: execution.id,
      ruleId: execution.ruleId,
      walletId: execution.walletId,
      destinationWalletId: execution.destinationWalletId,
    }
    const disabled = await rules.disableForDestination(
      execution.walletId,
      execution.destinationWalletId,
      { now: stamp() },
    )
    if (disabled instanceof Error) {
      logger.error(
        { ...logContext, error: disabled },
        "could not disable payment split rule with an inactive destination",
      )
      return foldShareToNet(error.name, "failed")
    }
    if (disabled) {
      logger.warn(
        logContext,
        "payment split rule disabled: destination account is not active",
      )
      return foldShareToNet(error.name, "disabled")
    }
    // Nothing flipped: either an earlier row already disabled the rule (it
    // still exists, its owner was told) or the rule is gone (edited away or
    // deleted), in which case nobody has told the owner about this payout.
    const exists = await rules.existsForDestination(
      execution.walletId,
      execution.destinationWalletId,
    )
    if (exists instanceof Error) {
      logger.error(
        { ...logContext, error: exists },
        "could not check payment split rule for an inactive destination",
      )
    }
    return foldShareToNet(error.name, exists !== true ? "failed" : undefined)
  }

  const retry = async (error: Error) => {
    await finish({
      status: "pending",
      attempts,
      // From the pass's `now`, so a row retried in this pass is due in a
      // later pass (see executePendingSplits).
      nextAttemptAt: new Date(now.getTime() + splitRetryBackoffMs(attempts)),
      lastError: error.name,
    })
    return "retry" as const
  }

  // Nothing has been sent yet: a transient error (a Mongo stepdown, a network
  // blip) gets the same retry budget as any pre-payment error. Only a definite
  // not-found (the wallet or account is gone) fails at once.
  const failBeforeSend = async (error: Error) => {
    if (
      !(error instanceof CouldNotFindError) &&
      attempts < PaymentSplitsConfig.maxAttempts
    ) {
      return retry(error)
    }
    return fail(error)
  }

  // The merchant's account: needed for owner notifications and (for the net
  // leg) the destination-active check.
  const wallet = await WalletsRepository().findById(execution.walletId as WalletId)
  if (wallet instanceof Error) return failBeforeSend(wallet)
  const account = await AccountsRepository().findById(wallet.accountId)
  if (account instanceof Error) return failBeforeSend(account)
  ownerAccountId = account.id

  // Re-check the internal-transfer marker at pay time. An LNURL send from
  // another Flash user is marked only after payToLnurl returns, so a receive
  // can be built before the marker exists (ENG-653 decision 1, kept).
  const internal = await isInternalTransferInvoice(execution.triggerKey)
  if (internal instanceof Error) {
    // Nothing was sent: the same retry budget as any pre-payment error.
    return failBeforeSend(internal)
  }
  if (internal && execution.legKind === "share") {
    // The trigger receive turned out to be Flash-to-Flash: it should never
    // have built legs. The share folds to the merchant like any other
    // terminal share failure — never dropped silently (the net leg below
    // pays; the money really is in the shadow and belongs to the merchant).
    return fail("internal_transfer", account.id)
  }

  // Set right before IBEX payInvoice. Between the marker write and this only
  // addInvoice runs, and it moves no money.
  let payInvoiceReached = false

  // The net leg's memo carries the gross in major units. grossMinor is minor
  // units: cents for USD, micros for USDT (10 000 micros per US cent — the
  // same conversion computeShare uses).
  const grossMajor =
    execution.currency === WalletCurrency.Usdt
      ? Number(execution.grossMinor) / 1_000_000
      : Number(execution.grossMinor) / 100
  const memo =
    execution.legKind === "net"
      ? `${NET_MEMO_PREFIX} $${grossMajor.toFixed(2)}`
      : PAYMENT_SPLIT_MEMO

  const result = await paySplitLeg({
    sourceIbexAccountId: execution.sourceIbexAccountId,
    destinationWalletId: execution.destinationWalletId,
    cents: execution.shareCents,
    currency: execution.currency,
    memo,
    onProgress: (progress) => {
      payInvoiceReached = progress.payInvoiceReached ?? false
    },
  })

  if (result instanceof Error) {
    if (isAmbiguousSplitSendError(result, { payInvoiceReached })) {
      await finish({ status: "unknown", attempts, lastError: result.name })
      logger.error(
        { executionId: execution.id, walletId: execution.walletId, error: result },
        "payment split send may have paid despite the error; marked unknown",
      )
      notifyOpsEvent({
        flow: "transfer",
        phase: "split-unknown",
        status: "failed",
        amount: { value: (execution.shareCents / 100).toFixed(2), currency: "USD" },
        meta: {
          executionId: execution.id,
          sourceIbexAccountId: execution.sourceIbexAccountId,
          recipientWalletId: execution.destinationWalletId,
          reason: result.name,
        },
      })
      return "unknown"
    }
    if (isRetryableSplitError(result) && attempts < PaymentSplitsConfig.maxAttempts) {
      return retry(result)
    }
    logger.warn(
      { executionId: execution.id, walletId: execution.walletId, error: result },
      "payment split failed",
    )
    if (
      result instanceof InactiveAccountError &&
      execution.legKind === "share" &&
      (await isDestinationInactive(execution.destinationWalletId))
    ) {
      return failAndDisableRule(result)
    }
    return fail(result, account.id)
  }

  if (result === PaymentSendStatus.Success) {
    await finish({ status: "sent", attempts })
    return "sent"
  }

  if (result === PaymentSendStatus.Pending) {
    // Money has probably left the shadow: never re-pay (same stance as v1 and
    // the Fygaro credit). Ops resolves the final state from IBEX.
    await finish({ status: "ibex_pending", attempts })
    return "ibex_pending"
  }

  return fail(`unexpected payment status: ${String(result.value)}`, account.id)
}

export type ExecutePendingSplitsSummary = {
  claimed: number
  sent: number
  ibexPending: number
  failed: number
  folded: number
  retried: number
  unknown: number
}

/**
 * Executor: claims due `pending` legs one at a time (atomically, so
 * concurrent runs never claim the same row) and pays each from the shadow
 * receive account named on the row.
 *
 * Runs every PaymentSplitsConfig.loopIntervalMs from the split loop AND once
 * inline after the webhook builds legs (§2.3: settle → execute immediately;
 * the loop is the retry/safety net). Keeps claiming until nothing is due or
 * executorTimeBudgetMs is spent. `now` is fixed per pass and decides what is
 * due; claims and outcomes are stamped with `clock()` (wall-clock time), so a
 * row's updatedAt never looks older to the stale sweep on another replica
 * than it really is.
 *
 * `shouldStop` lets the loop drain on SIGTERM (see startPaymentSplitsLoop).
 */
export const executePendingSplits = async ({
  now = new Date(),
  clock = () => Date.now(),
  shouldStop = () => false,
}: { now?: Date; clock?: () => number; shouldStop?: () => boolean } = {}): Promise<
  ExecutePendingSplitsSummary | Error
> => {
  const summary: ExecutePendingSplitsSummary = {
    claimed: 0,
    sent: 0,
    ibexPending: 0,
    failed: 0,
    folded: 0,
    retried: 0,
    unknown: 0,
  }
  if (!PaymentSplitsConfig.enabled) return summary

  const executions = PaymentSplitExecutionsRepository()
  const stamp = () => new Date(clock())
  const deadline = clock() + PaymentSplitsConfig.executorTimeBudgetMs
  // `shouldStop` is checked before every claim, so on shutdown the row in
  // flight finishes and no new row moves to `sending` (where a kill would
  // strand it for the stale sweep to mark `unknown`).
  while (clock() < deadline && !shouldStop()) {
    const execution = await executions.claimNextDue(now, stamp())
    if (execution instanceof Error) return execution
    if (execution === null) break

    summary.claimed += 1
    const outcome = await executeOne(execution, now, stamp)
    if (outcome === "sent") summary.sent += 1
    else if (outcome === "ibex_pending") summary.ibexPending += 1
    else if (outcome === "failed") summary.failed += 1
    else if (outcome === "unknown") summary.unknown += 1
    else if (outcome === "folded") summary.folded += 1
    else summary.retried += 1
  }

  return summary
}
