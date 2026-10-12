import { PaymentSplitsConfig } from "@config"

import { notifyOpsEvent } from "@services/alerts/ops-events"
import { baseLogger } from "@services/logger"
import { PaymentSplitExecutionsRepository } from "@services/mongoose/payment-split-executions"

export const STALE_SENDING_MS = 10 * 60 * 1000

// Bound on rows moved per run, so a pathological backlog cannot hold the cron.
const MAX_SWEEP = 100

/**
 * A row still `sending` after STALE_SENDING_MS means the executor died between
 * claiming it and recording the outcome — the send may or may not have gone
 * out. It becomes `unknown` and raises an ops alert. It is NEVER resent
 * automatically: the send's idempotency cache lives only 24h and a crash before
 * the cache write leaves nothing to replay, so a resend could pay twice.
 */
export const sweepStaleSplits = async ({
  now = new Date(),
}: { now?: Date } = {}): Promise<{ markedUnknown: number } | Error> => {
  if (!PaymentSplitsConfig.enabled) return { markedUnknown: 0 }

  const executions = PaymentSplitExecutionsRepository()
  const cutoff = new Date(now.getTime() - STALE_SENDING_MS)
  let markedUnknown = 0

  for (let i = 0; i < MAX_SWEEP; i++) {
    const stale = await executions.markNextStaleUnknown(cutoff, now)
    if (stale instanceof Error) return stale
    if (stale === null) break

    markedUnknown += 1
    baseLogger.error(
      { executionId: stale.id, walletId: stale.walletId },
      "payment split stuck in sending; marked unknown for manual resolution",
    )
    notifyOpsEvent({
      flow: "transfer",
      phase: "split-unknown",
      status: "failed",
      amount: { value: (stale.shareCents / 100).toFixed(2), currency: "USD" },
      meta: {
        executionId: stale.id,
        senderWalletId: stale.walletId,
        recipientWalletId: stale.destinationWalletId,
        reason: "stuck-in-sending",
      },
    })
  }

  return { markedUnknown }
}
