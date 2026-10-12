import { PaymentSplitsConfig } from "@config"

import { sendOutcomeNotificationBestEffort } from "@app/notifications/send-outcome-notification"
import { authorizeSend } from "@app/payments/authorize-send"
import { intraledgerPaymentSendWalletIdForUsdWallet } from "@app/payments/send-intraledger"

import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { LockServiceError } from "@domain/lock"
import { InternalTransferMarkerError, splitRetryBackoffMs } from "@domain/payment-splits"
import { SendLimitsUnavailableError } from "@domain/payments/errors"
import { RateLimitServiceError } from "@domain/rate-limit/errors"

import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
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
 * or a price, a busy idempotency lock, the internal-transfer marker write, an
 * IBEX 429). Everything else — limits, KYC level, insufficient balance, an
 * inactive account, an unknown IBEX error — is terminal on the first attempt,
 * so an error whose payment outcome is unknown is never re-sent.
 */
export const isRetryableSplitError = (error: Error): boolean =>
  error instanceof RateLimitServiceError ||
  error instanceof SendLimitsUnavailableError ||
  error instanceof LockServiceError ||
  error instanceof InternalTransferMarkerError ||
  (error instanceof IbexError && error.httpCode === 429)

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

type ExecuteOutcome = "sent" | "ibex_pending" | "failed" | "retry"

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

  const wallet = await WalletsRepository().findById(execution.walletId as WalletId)
  if (wallet instanceof Error) return fail(wallet)
  const account = await AccountsRepository().findById(wallet.accountId)
  if (account instanceof Error) return fail(account)

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
    authorize: () =>
      authorizeSend({
        senderAccount: account,
        senderWalletId: wallet.id,
        amount: { currency: "USD", cents: execution.shareCents },
        kind: "intraledger",
      }),
  })

  if (result instanceof Error) {
    if (isRetryableSplitError(result) && attempts < PaymentSplitsConfig.maxAttempts) {
      await executions.finishClaimed(execution.id, {
        status: "pending",
        attempts,
        nextAttemptAt: new Date(now.getTime() + splitRetryBackoffMs(attempts)),
        lastError: result.name,
        now,
      })
      return "retry"
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
}

/**
 * Cron executor: claims due `pending` executions one at a time (atomically, so
 * concurrent runs never claim the same row) and pays each share as an
 * intraledger send from the receiving wallet to the split destination.
 */
export const executePendingSplits = async ({
  now = new Date(),
}: { now?: Date } = {}): Promise<ExecutePendingSplitsSummary | Error> => {
  const summary: ExecutePendingSplitsSummary = {
    claimed: 0,
    sent: 0,
    ibexPending: 0,
    failed: 0,
    retried: 0,
  }
  if (!PaymentSplitsConfig.enabled) return summary

  const executions = PaymentSplitExecutionsRepository()
  for (let i = 0; i < PaymentSplitsConfig.executorBatchSize; i++) {
    const execution = await executions.claimNextDue(now)
    if (execution instanceof Error) return execution
    if (execution === null) break

    summary.claimed += 1
    const outcome = await executeOne(execution, now)
    if (outcome === "sent") summary.sent += 1
    else if (outcome === "ibex_pending") summary.ibexPending += 1
    else if (outcome === "failed") summary.failed += 1
    else summary.retried += 1
  }

  return summary
}
