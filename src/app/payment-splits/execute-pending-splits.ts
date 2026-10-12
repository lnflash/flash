import { PaymentSplitsConfig } from "@config"

import { sendOutcomeNotificationBestEffort } from "@app/notifications/send-outcome-notification"
import { authorizeSend } from "@app/payments/authorize-send"
import { isDefinitivePaymentRejection } from "@app/payments/mark-outgoing-invoice"
import { intraledgerPaymentSendWalletIdForUsdWallet } from "@app/payments/send-intraledger"

import { AccountValidator } from "@domain/accounts"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { CouldNotFindError, InactiveAccountError } from "@domain/errors"
import { LockServiceError, ResourceAttemptsLockServiceError } from "@domain/lock"
import { InternalTransferMarkerError, splitRetryBackoffMs } from "@domain/payment-splits"
import { SendLimitsUnavailableError } from "@domain/payments/errors"
import { RateLimitServiceError } from "@domain/rate-limit/errors"

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

const logger = baseLogger.child({ module: "payment-splits" })

export const PAYMENT_SPLIT_MEMO = "Payment split"

export const splitIdempotencyKey = (executionId: string): IdempotencyKey =>
  `split:${executionId}` as IdempotencyKey

type SendProgress = {
  // The ENG-573 guard (the `authorize` hook) passed. withPaymentIdempotency
  // runs it inside the idempotency lock just before `execute`.
  paymentAttempted: boolean
  // The send reached IBEX payInvoice (the `beforePay` hook ran). Before this,
  // only IBEX addInvoice (minting the recipient invoice) and the
  // internal-transfer marker write ran, and neither moves money.
  payInvoiceReached?: boolean
}

/**
 * Errors worth another attempt: raised before IBEX paid anything and expected
 * to clear on their own (rate limits, a send guard that could not reach Redis
 * or a price, the internal-transfer marker write, an IBEX 429, a busy
 * idempotency lock that was never acquired, and any IBEX error from minting
 * the recipient invoice that is not a definitive 4xx). Everything else
 * (limits, KYC level, insufficient balance, an inactive account, an IBEX error
 * from payInvoice) is terminal on the first attempt, so an error whose payment
 * outcome is unknown is never re-sent.
 *
 * An addInvoice failure is safe to retry: no payment was attempted and the
 * error return is left uncached by withPaymentIdempotency, so the same key
 * re-runs the whole send.
 *
 * Lock errors are the subtle case. redlock also returns a LockServiceError when
 * the locked routine throws or when releasing the lock fails, and both can
 * happen AFTER the IBEX payment succeeded, replacing the Success result. So a
 * lock error is retryable only when it is ResourceAttemptsLockServiceError AND
 * the send never reached the payment (`paymentAttempted` false: the authorize
 * hook, which runs immediately before the payment, never passed).
 */
export const isRetryableSplitError = (
  error: Error,
  { paymentAttempted, payInvoiceReached = false }: SendProgress,
): boolean => {
  if (error instanceof LockServiceError) {
    return error instanceof ResourceAttemptsLockServiceError && !paymentAttempted
  }
  if (error instanceof IbexError) {
    if (error.httpCode === 429) return true
    return paymentAttempted && !payInvoiceReached && !isDefinitivePaymentRejection(error)
  }
  return (
    error instanceof RateLimitServiceError ||
    error instanceof SendLimitsUnavailableError ||
    error instanceof InternalTransferMarkerError
  )
}

/**
 * An error the send may have paid through. Treated like a row the stale sweep
 * finds stuck in `sending`: `unknown` plus an ops alert, never resent, and no
 * "split failed" push to the owner (who would then pay the partner by hand).
 *
 * - A lock error that is not a retryable pre-payment one (see
 *   isRetryableSplitError).
 * - Once the send reached IBEX payInvoice (`payInvoiceReached`), any IBEX error
 *   that is not a definitive rejection: a transport error, a timeout or a 5xx
 *   from payInvoice, where IBEX may already have debited (the KNOWN GAP in
 *   idempotency.ts). A definitive rejection (insufficient balance, a 4xx such
 *   as no route or a 429) moved no money and stays `failed` / retryable. An
 *   IBEX error from addInvoice (before payInvoice) moved nothing either and is
 *   retried.
 */
export const isAmbiguousSplitSendError = (
  error: Error,
  { paymentAttempted, payInvoiceReached = false }: SendProgress,
): boolean => {
  if (error instanceof LockServiceError) {
    return !isRetryableSplitError(error, { paymentAttempted, payInvoiceReached })
  }
  return (
    payInvoiceReached &&
    error instanceof IbexError &&
    !isDefinitivePaymentRejection(error)
  )
}

const formatCents = (cents: number): string => `US$${(cents / 100).toFixed(2)}`

const notifyOwner = async (
  accountId: string,
  outcome: "sent" | "failed" | "disabled",
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
    logMessage: `Failed to send payment split ${outcome} push notification`,
    logContext: { executionId: execution.id, walletId: execution.walletId },
  })

/**
 * ENG-660: whether the split's DESTINATION account is inactive right now.
 * InactiveAccountError from the send does not say which side was inactive
 * (the sender is checked first), so the destination is looked up directly.
 * A lookup failure answers false: the row then fails as before and the rule
 * stays enabled.
 */
const isDestinationInactive = async (destinationWalletId: string): Promise<boolean> => {
  const wallet = await WalletsRepository().findById(destinationWalletId as WalletId)
  if (wallet instanceof Error) return false
  const account = await AccountsRepository().findById(wallet.accountId)
  if (account instanceof Error) return false
  return AccountValidator(account).isActive() instanceof Error
}

type ExecuteOutcome =
  | "sent"
  | "ibex_pending"
  | "failed"
  | "retry"
  | "unknown"
  | "skipped_internal"

const executeOne = async (
  execution: PaymentSplitExecutionRecord,
  now: Date,
  stamp: () => Date,
): Promise<ExecuteOutcome> => {
  const executions = PaymentSplitExecutionsRepository()
  const attempts = execution.attempts + 1

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

  const fail = async (error: Error | string, accountId?: string) => {
    const lastError = typeof error === "string" ? error : error.name || error.message
    await finish({ status: "failed", attempts, lastError })
    if (accountId) await notifyOwner(accountId, "failed", execution)
    return "failed" as const
  }

  // ENG-660: the destination account is no longer active, so every later
  // payout to it would fail the same way. Turn off the wallet's rules to that
  // destination and tell the owner once (only the call that flipped `enabled`
  // notifies); further rows for the same destination fail without another
  // push. The rules are matched by destination, not by execution.ruleId: a
  // save replaces every rule with a new id, and a delete removes it, so the
  // recorded ruleId may no longer exist. When nothing was disabled AND no rule
  // to the destination exists any more, the owner still gets the ordinary
  // "failed" push, so a failed payout is never silent.
  const failAndDisableRule = async (error: Error, accountId: string) => {
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
      await notifyOwner(accountId, "failed", execution)
      return "failed" as const
    }
    if (disabled) {
      logger.warn(
        logContext,
        "payment split rule disabled: destination account is not active",
      )
      await notifyOwner(accountId, "disabled", execution)
      return "failed" as const
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
    if (exists !== true) await notifyOwner(accountId, "failed", execution)
    return "failed" as const
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

  // Re-check the internal-transfer marker at pay time. An LNURL send from
  // another Flash user is marked only after IBEX returns, so its receive can be
  // recorded before the marker exists (ENG-653 decision 1).
  const internal = await isInternalTransferInvoice(execution.triggerKey)
  if (internal instanceof Error) {
    // Nothing was sent: the same retry budget as any pre-payment error.
    return failBeforeSend(internal)
  }
  if (internal) {
    await finish({ status: "skipped_internal", attempts: execution.attempts })
    return "skipped_internal"
  }

  const wallet = await WalletsRepository().findById(execution.walletId as WalletId)
  if (wallet instanceof Error) return failBeforeSend(wallet)
  const account = await AccountsRepository().findById(wallet.accountId)
  if (account instanceof Error) return failBeforeSend(account)

  // Set once the ENG-573 guard passes. withPaymentIdempotency runs `authorize`
  // inside the idempotency lock immediately before the payment, so this is the
  // last point at which no money can have moved yet.
  let paymentAttempted = false
  // Set right before IBEX payInvoice. Between the two only IBEX addInvoice and
  // the marker write run, and neither moves money.
  let payInvoiceReached = false

  const result = await intraledgerPaymentSendWalletIdForUsdWallet({
    senderWalletId: wallet.id,
    recipientWalletId: execution.destinationWalletId as WalletId,
    amount: execution.shareCents,
    memo: PAYMENT_SPLIT_MEMO,
    senderAccount: account,
    // Stable across retries of the same execution, so a retry after an
    // ambiguous failure replays the cached outcome instead of paying again.
    idempotencyKey: splitIdempotencyKey(execution.id),
    // A split is a send out of the user's own wallet: it goes through the same
    // ENG-573 guard (attempt budget, amount sanity, daily limit) as a manual
    // intraledger send.
    authorize: async () => {
      const authorized = await authorizeSend({
        senderAccount: account,
        senderWalletId: wallet.id,
        amount: { currency: "USD", cents: execution.shareCents },
        kind: "intraledger",
      })
      if (!(authorized instanceof Error)) paymentAttempted = true
      return authorized
    },
    beforePay: () => {
      payInvoiceReached = true
    },
  })

  if (result instanceof Error) {
    if (isAmbiguousSplitSendError(result, { paymentAttempted, payInvoiceReached })) {
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
          senderWalletId: execution.walletId,
          recipientWalletId: execution.destinationWalletId,
          reason: result.name,
        },
      })
      return "unknown"
    }
    if (
      isRetryableSplitError(result, { paymentAttempted, payInvoiceReached }) &&
      attempts < PaymentSplitsConfig.maxAttempts
    ) {
      return retry(result)
    }
    logger.warn(
      { executionId: execution.id, walletId: execution.walletId, error: result },
      "payment split failed",
    )
    if (
      result instanceof InactiveAccountError &&
      (await isDestinationInactive(execution.destinationWalletId))
    ) {
      return failAndDisableRule(result, account.id)
    }
    return fail(result, account.id)
  }

  if (result === PaymentSendStatus.Success) {
    await finish({ status: "sent", attempts })
    await notifyOwner(account.id, "sent", execution)
    return "sent"
  }

  if (result === PaymentSendStatus.Pending) {
    // Money has probably left the wallet: never re-pay (same stance as the
    // Fygaro credit). Ops resolves the final state from IBEX.
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
  retried: number
  unknown: number
  skippedInternal: number
}

/**
 * Executor: claims due `pending` executions one at a time (atomically, so
 * concurrent runs never claim the same row) and pays each share as an
 * intraledger send from the receiving wallet to the split destination.
 *
 * Runs every PaymentSplitsConfig.loopIntervalMs from the split loop and keeps
 * claiming until nothing is due or executorTimeBudgetMs is spent, so the
 * throughput is not capped by a fixed batch per run. `now` is fixed per pass
 * and decides what is due: a row retried in this pass is due at now + backoff
 * and is picked up by a later pass, which is what makes the 1/2/4/8 minute
 * backoff real. Claims and outcomes are stamped with `clock()` (wall-clock
 * time), never the pass's `now`, so a row's updatedAt never looks older to the
 * stale sweep on another replica than it really is.
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
    retried: 0,
    unknown: 0,
    skippedInternal: 0,
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
    else if (outcome === "skipped_internal") summary.skippedInternal += 1
    else summary.retried += 1
  }

  return summary
}
