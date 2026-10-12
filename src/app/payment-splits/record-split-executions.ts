import { PaymentSplitsConfig } from "@config"

import { computeShare, isSplitCurrency } from "@domain/payment-splits"

import { isInternalTransferInvoice } from "@services/mongoose/internal-transfer-invoices"
import { PaymentSplitExecutionsRepository } from "@services/mongoose/payment-split-executions"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"

export type RecordSplitExecutionsResult = {
  recorded: number
  duplicates: number
  skippedMin: number
}

const NOTHING: RecordSplitExecutionsResult = { recorded: 0, duplicates: 0, skippedMin: 0 }

/**
 * Records one pending split execution per enabled rule on `walletId` for one
 * receive. Shared by the on-receive webhook and the reconcile cron, which both
 * key the receive by its payment hash so the unique (triggerKey, ruleId) index
 * dedupes them against each other and against webhook replays.
 *
 * Never sends: payouts happen only in the cron executor.
 *
 * `receivedAt`, when known (the cron reads it from IBEX), keeps a rule from
 * firing on a receive that settled before the rule was created.
 */
export const recordSplitExecutions = async ({
  walletId,
  triggerKey,
  paymentHash,
  amount,
  currency,
  receivedAt,
  now = new Date(),
}: {
  walletId: string
  triggerKey: string
  paymentHash?: string
  amount: number
  currency: string
  receivedAt?: Date
  now?: Date
}): Promise<RecordSplitExecutionsResult | Error> => {
  if (!PaymentSplitsConfig.enabled) return NOTHING
  if (!isSplitCurrency(currency)) return NOTHING

  const rules = await PaymentSplitRulesRepository().listByWalletId(walletId, {
    enabledOnly: true,
  })
  if (rules instanceof Error) return rules
  if (rules.length === 0) return NOTHING

  // Invoices Flash minted for its own transfers (P2P, Fygaro top-ups, referral
  // payouts, split payouts, cutover moves) never trigger splits.
  if (paymentHash) {
    const internal = await isInternalTransferInvoice(paymentHash)
    if (internal instanceof Error) return internal
    if (internal) return NOTHING
  }

  const executions = PaymentSplitExecutionsRepository()
  const result = { ...NOTHING }
  for (const rule of rules) {
    if (receivedAt && receivedAt.getTime() < rule.createdAt.getTime()) continue

    const share = computeShare({
      amount,
      currency,
      percent: rule.percent,
      minShareCents: PaymentSplitsConfig.minShareCents,
    })
    if (share instanceof Error) return share

    const inserted = await executions.insert({
      triggerKey,
      ruleId: rule.id,
      walletId,
      destinationWalletId: rule.destinationWalletId,
      currency,
      triggerAmountMinor: share.triggerAmountMinor,
      shareCents: share.shareCents,
      status: share.status === "ok" ? "pending" : "skipped_min",
      now,
    })
    if (inserted instanceof Error) return inserted
    if (!inserted.inserted) result.duplicates += 1
    else if (share.status === "skipped_min") result.skippedMin += 1
    else result.recorded += 1
  }
  return result
}
