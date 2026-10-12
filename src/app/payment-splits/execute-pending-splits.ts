import { PaymentSplitsConfig } from "@config"

import { sendOutcomeNotificationBestEffort } from "@app/notifications/send-outcome-notification"
import { authorizeSend } from "@app/payments/authorize-send"
import { intraledgerPaymentSendWalletIdForUsdWallet } from "@app/payments/send-intraledger"

import { PaymentSendStatus } from "@domain/bitcoin/lightning"
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

const logger = baseLogger.child({ module: "payment-splits" })

export const PAYMENT_SPLIT_MEMO = "Payment split"

export const splitIdempotencyKey = (executionId: string): IdempotencyKey =>
  `split:${executionId}` as IdempotencyKey

/**
 * Errors worth another attempt: raised before IBEX paid anything and expected
 * to clear on their own (rate limits, a send guard that could not reach Redis
 * or a price, the internal-transfer marker write, an IBEX 429, and a busy
 * idempotency lock that was never acquired). Everything else — limits, KYC
 * level, insufficient balance, an inactive account, an unknown IBEX error — is
 * terminal on the first attempt, so an error whose payment outcome is unknown
 * is never re-sent.
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
  { paymentAttempted }: { paymentAttempted: boolean },
): boolean => {
  if (error instanceof LockServiceError) {
    return error instanceof ResourceAttemptsLockServiceError && !paymentAttempted
  }
  return (
    error instanceof RateLimitServiceError ||
    error instanceof SendLimitsUnavailableError ||
    error instanceof InternalTransferMarkerError ||
    (error instanceof IbexError && error.httpCode === 429)
  )
}

/**
 * A lock error the send may have paid through (see isRetryableSplitError).
 * Treated like a row the stale sweep finds stuck in `sending`: `unknown` plus
 * an ops alert, never resent.
 */
const isAmbiguousLockError = (
  error: Error,
  { paymentAttempted }: { paymentAttempted: boolean },
): boolean =>
  error instanceof LockServiceError && !isRetryableSplitError(error, { paymentAttempted })

const formatCents = (cents: number): string => `US$${(cents / 100).toFixed(2)}`

const notifyOwner = async (
  accountId: string,
  outcome: "sent" | "failed",
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
): Promise<ExecuteOutcome> => {
  const executions = PaymentSplitExecutionsRepository()
  const attempts = execution.attempts + 1

  const fail = async (error: Error | string, accountId?: string) => {
    const lastError = typeof error === "string" ? error : error.name || error.message
    await executions.finishClaimed(execution.id, {
      status: "failed",
      attempts,
      lastError,
      now,
    })
    if (accountId) await notifyOwner(accountId, "failed", execution)
    return "failed" as const
  }

  const retry = async (error: Error) => {
    await executions.finishClaimed(execution.id, {
      status: "pending",
      attempts,
      nextAttemptAt: new Date(now.getTime() + splitRetryBackoffMs(attempts)),
      lastError: error.name,
      now,
    })
    return "retry" as const
  }

  // Re-check the internal-transfer marker at pay time. An LNURL send from
  // another Flash user is marked only after IBEX returns, so its receive can be
  // recorded before the marker exists (ENG-653 decision 1).
  const internal = await isInternalTransferInvoice(execution.triggerKey)
  if (internal instanceof Error) {
    // Nothing was sent: the same retry budget as any pre-payment error.
    if (attempts < PaymentSplitsConfig.maxAttempts) return retry(internal)
    return fail(internal)
  }
  if (internal) {
    await executions.finishClaimed(execution.id, {
      status: "skipped_internal",
      attempts: execution.attempts,
      now,
    })
    return "skipped_internal"
  }

  const wallet = await WalletsRepository().findById(execution.walletId as WalletId)
  if (wallet instanceof Error) return fail(wallet)
  const account = await AccountsRepository().findById(wallet.accountId)
  if (account instanceof Error) return fail(account)

  // Set once the ENG-573 guard passes. withPaymentIdempotency runs `authorize`
  // inside the idempotency lock immediately before the payment, so this is the
  // last point at which no money can have moved yet.
  let paymentAttempted = false

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
  })

  if (result instanceof Error) {
    if (isAmbiguousLockError(result, { paymentAttempted })) {
      await executions.finishClaimed(execution.id, {
        status: "unknown",
        attempts,
        lastError: result.name,
        now,
      })
      logger.error(
        { executionId: execution.id, walletId: execution.walletId, error: result },
        "payment split lock error after the send may have paid; marked unknown",
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
      isRetryableSplitError(result, { paymentAttempted }) &&
      attempts < PaymentSplitsConfig.maxAttempts
    ) {
      return retry(result)
    }
    logger.warn(
      { executionId: execution.id, walletId: execution.walletId, error: result },
      "payment split failed",
    )
    return fail(result, account.id)
  }

  if (result === PaymentSendStatus.Success) {
    await executions.finishClaimed(execution.id, { status: "sent", attempts, now })
    await notifyOwner(account.id, "sent", execution)
    return "sent"
  }

  if (result === PaymentSendStatus.Pending) {
    // Money has probably left the wallet: never re-pay (same stance as the
    // Fygaro credit). Ops resolves the final state from IBEX.
    await executions.finishClaimed(execution.id, {
      status: "ibex_pending",
      attempts,
      now,
    })
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
 * throughput is not capped by a fixed batch per run. `now` is fixed per pass:
 * a row retried in this pass is due at now + backoff and is picked up by a
 * later pass, which is what makes the 1/2/4/8 minute backoff real.
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
  const deadline = clock() + PaymentSplitsConfig.executorTimeBudgetMs
  // `shouldStop` is checked before every claim, so on shutdown the row in
  // flight finishes and no new row moves to `sending` (where a kill would
  // strand it for the stale sweep to mark `unknown`).
  while (clock() < deadline && !shouldStop()) {
    const execution = await executions.claimNextDue(now)
    if (execution instanceof Error) return execution
    if (execution === null) break

    summary.claimed += 1
    const outcome = await executeOne(execution, now)
    if (outcome === "sent") summary.sent += 1
    else if (outcome === "ibex_pending") summary.ibexPending += 1
    else if (outcome === "failed") summary.failed += 1
    else if (outcome === "unknown") summary.unknown += 1
    else if (outcome === "skipped_internal") summary.skippedInternal += 1
    else summary.retried += 1
  }

  return summary
}
