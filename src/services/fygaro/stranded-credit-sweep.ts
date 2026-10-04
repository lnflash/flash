import { FygaroConfig } from "@config"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import {
  completeFygaroTopup,
  listUncreditedFygaroTopupsLastDays,
  readFygaroTopupCompletion,
} from "@services/frappe/BridgeTransferRequestWriter"
import { getFlashFeeDiscountPercent } from "@services/frappe/fee-discounts"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import { sendFygaroTopupNotificationBestEffort } from "@app/fygaro/send-topup-notification"

import {
  creditFygaroTopup,
  FygaroCreditError,
  INSUFFICIENT_TREASURY_FLOAT_STEP,
} from "./webhook-server/credit-topup"
import { computeFygaroFees } from "./webhook-server/fees"
import { getFygaroSettings } from "./webhook-server/fygaro-settings"

/**
 * Stranded-credit sweep.
 *
 * When the bankowner treasury is empty, a verified card payment is recorded
 * (Fiat Received, attributed, NO failure_reason) and the credit fails with
 * `insufficient-treasury-float`. payment.ts deliberately leaves that row
 * un-stamped so the payment keeps counting against the customer's daily cap
 * while a retry is pending — but the only retry that existed was Fygaro
 * re-delivering the webhook, which it does not do for a 200. So every such
 * payment became a manual credit + a manual Mark Completed, with a duplicate-
 * row trap for whoever did it (2026-10-03).
 *
 * This sweep re-runs the SAME credit path once the float is back:
 *   - candidates come from ERPNext (listUncreditedFygaroTopups: Fiat Received,
 *     USD, attributed, no failure_reason, not email-attributed, oldest first),
 *   - fees are recomputed with the same engine the webhook uses
 *     (computeFygaroFees + the operator fee-discount whitelist),
 *   - the status is re-read right before the send so a row ops hand-completed
 *     in the meantime is skipped,
 *   - the send is creditFygaroTopup, idempotent on `fygaro:<transactionId>`,
 *     so even a lost race with a concurrent webhook retry cannot double-pay,
 *   - on success the row is promoted exactly as the webhook promotes it (full
 *     fee split, so the admin never shows "Pending" fees on a credited row).
 *
 * The daily-cap gate is NOT re-applied. The payment passed it when it was
 * captured (a refusal would have stamped a failure_reason); refusing it now
 * because the customer topped up again since would strand it forever. The
 * gates that ARE re-applied are the ones that could have changed in a way
 * that must still hold at send time: auto-credit still on, gross still at or
 * under the auto-credit limit, net still positive.
 *
 * Never retried: rows with a failure_reason (every gate refusal), rows with no
 * account_id (unattributed), email-attributed rows. Non-float failures
 * (`intraledger-send`, unresolvable recipient wallet) alert per payment and
 * are left for the next sweep; a float failure stops the sweep — the balance
 * the caller read is stale and nothing else will fit either.
 */

export type StrandedCreditSweepSummary = {
  candidates: number
  credited: number
  skippedCompleted: number
  uncovered: number
  failed: number
  stoppedOnFloat: boolean
}

const DEFAULT_LOOKBACK_DAYS = 7
const DEFAULT_MAX_PER_SWEEP = 20

const centsToDollars = (cents: number): string => (cents / 100).toFixed(2)

const parseRawPayload = (raw: string | null | undefined): unknown => {
  if (!raw) return { source: "stranded-credit-sweep" }
  try {
    return JSON.parse(raw)
  } catch {
    return { source: "stranded-credit-sweep" }
  }
}

const transactionIdOf = (requestId: string): string | undefined =>
  requestId.startsWith("fygaro:") ? requestId.slice("fygaro:".length) : undefined

const emptySummary = (): StrandedCreditSweepSummary => ({
  candidates: 0,
  credited: 0,
  skippedCompleted: 0,
  uncovered: 0,
  failed: 0,
  stoppedOnFloat: false,
})

/**
 * @param availableUsd the treasury balance the caller just read. Candidates
 *   whose net exceeds what is left are reported `uncovered` (warning) and
 *   skipped, so a $400 payment never blocks a $20 one behind it.
 */
export const retryStrandedFygaroCredits = async ({
  availableUsd,
}: {
  availableUsd: number
}): Promise<StrandedCreditSweepSummary> => {
  const summary = emptySummary()
  if (!FygaroConfig.enabled || !FygaroConfig.credit?.enabled) return summary
  if (FygaroConfig.retry?.enabled === false) return summary

  const lookbackDays = FygaroConfig.retry?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  const maxPerSweep = FygaroConfig.retry?.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP

  try {
    // Ops kill-switch: with auto-credit toggled off in ERPNext the webhook
    // records only, and so does this sweep. Settings unavailable = same answer
    // (fail closed, like the webhook's settings-unavailable gate).
    const settings = await getFygaroSettings()
    if (!settings?.autoCreditEnabled) {
      baseLogger.info("Fygaro stranded-credit sweep: auto-credit disabled, nothing to do")
      return summary
    }

    const rows = await listUncreditedFygaroTopupsLastDays({
      days: lookbackDays,
      limit: maxPerSweep,
    })
    if (rows instanceof Error) {
      baseLogger.warn(
        { err: rows },
        "Fygaro stranded-credit sweep: could not list uncredited top-ups",
      )
      return summary
    }
    summary.candidates = rows.length
    if (rows.length === 0) return summary

    let remainingUsd = availableUsd
    const autoCreditLimitCents = Math.round(settings.autoCreditLimit * 100)

    for (const row of rows) {
      const transactionId = transactionIdOf(row.request_id)
      if (!transactionId || !row.account_id) continue
      const accountId = row.account_id as AccountId

      const grossDollars = row.amount == null ? NaN : Number(row.amount)
      const grossCents = Math.round(grossDollars * 100)
      if (!Number.isFinite(grossCents) || grossCents <= 0) {
        baseLogger.warn(
          { transactionId, amount: row.amount },
          "Fygaro stranded-credit sweep: unparsable gross amount, skipping",
        )
        summary.failed += 1
        continue
      }
      if (grossCents > autoCreditLimitCents) {
        // Above the auto-credit limit this was always a manual credit; the
        // webhook would have refused it with `over-limit` and stamped the
        // row, so reaching here means the limit was lowered since. Leave it.
        baseLogger.info(
          { transactionId, grossCents, autoCreditLimitCents },
          "Fygaro stranded-credit sweep: gross over auto-credit limit, leaving for manual",
        )
        continue
      }

      const account = await AccountsRepository().findById(accountId)
      if (account instanceof Error) {
        baseLogger.warn(
          { transactionId, accountId, err: account },
          "Fygaro stranded-credit sweep: account lookup failed, skipping",
        )
        summary.failed += 1
        continue
      }

      const flashFeeDiscountPercent = await getFlashFeeDiscountPercent({
        username: account.username,
        flow: "topup",
      })
      const fees = computeFygaroFees({ grossCents, settings, flashFeeDiscountPercent })
      if (fees.netCents <= 0) {
        baseLogger.warn(
          { transactionId, fees },
          "Fygaro stranded-credit sweep: non-positive net, leaving for manual",
        )
        continue
      }

      const netUsd = fees.netCents / 100
      if (netUsd > remainingUsd) {
        summary.uncovered += 1
        alertBridge({
          dedupKey: generateDedupKey.fygaroRetryUncovered(transactionId),
          source: "fygaro-webhook",
          severity: "warning",
          title:
            "Fygaro stranded top-up still uncovered — treasury float too low to retry",
          detail: `net=$${centsToDollars(fees.netCents)} available=$${remainingUsd.toFixed(2)}`,
          context: {
            transaction_id: transactionId,
            account_id: accountId,
            net_usd: netUsd,
            available_usd: remainingUsd,
          },
        })
        continue
      }

      // Re-read right before the send: ops may have hand-credited and marked
      // this row Completed since the list was fetched. The idempotent send
      // would still not double-pay (different idempotency key from a manual
      // app send, but the row is the processed marker ops relies on), so
      // honour the row.
      const completion = await readFygaroTopupCompletion(transactionId)
      if (completion.completed) {
        summary.skippedCompleted += 1
        baseLogger.info(
          { transactionId },
          "Fygaro stranded-credit sweep: row already Completed, skipping",
        )
        continue
      }

      const creditResult = await creditFygaroTopup({
        recipientAccountId: accountId,
        amountCents: fees.netCents,
        transactionId,
      })
      if (creditResult instanceof FygaroCreditError) {
        summary.failed += 1
        const floatExhausted = creditResult.step === INSUFFICIENT_TREASURY_FLOAT_STEP
        baseLogger.error(
          { transactionId, accountId, step: creditResult.step, err: creditResult },
          "Fygaro stranded-credit sweep: retry credit failed",
        )
        if (floatExhausted) {
          // The balance we were handed is stale; nothing after this fits.
          summary.stoppedOnFloat = true
          alertBridge({
            dedupKey: generateDedupKey.fygaroFloatExhausted(),
            source: "fygaro-webhook",
            severity: "critical",
            title:
              "Fygaro treasury float EXHAUSTED during stranded-credit retry — fund bankowner",
            detail: `${creditResult.step}: ${creditResult.message}`,
            context: { transaction_id: transactionId, account_id: accountId },
          })
          break
        }
        alertBridge({
          dedupKey: generateDedupKey.fygaroRetryFailed(transactionId),
          source: "fygaro-webhook",
          severity: "warning",
          title: "Fygaro stranded top-up retry failed — manual credit may be needed",
          detail: `${creditResult.step}: ${creditResult.message}`,
          context: { transaction_id: transactionId, account_id: accountId },
        })
        continue
      }

      remainingUsd -= netUsd
      summary.credited += 1

      const completeResult = await completeFygaroTopup({
        transactionId,
        accountId,
        walletId: creditResult.walletId,
        amount: centsToDollars(grossCents),
        currency: row.currency ?? "USD",
        initialAmount: centsToDollars(fees.grossCents),
        processorFee: centsToDollars(fees.processorFeeCents),
        flashFee: centsToDollars(fees.flashFeeCents),
        finalAmount: centsToDollars(fees.netCents),
        rawPayload: parseRawPayload(row.raw_payload_json),
      })
      if (completeResult instanceof Error) {
        // Money moved; only the promotion failed. Same stance as the webhook:
        // alert, keep going, the next sweep re-reads the row as uncredited and
        // the idempotent send replays for free before promoting again.
        alertBridge({
          dedupKey: generateDedupKey.erpnextFygaroAudit(transactionId),
          source: "erpnext-audit",
          severity: "warning",
          title: "Fygaro retry credit succeeded but ERPNext promotion failed",
          detail: completeResult.message,
          context: { transaction_id: transactionId },
        })
      }

      notifyOpsEvent({
        flow: "deposit",
        phase: "succeeded",
        status: "success",
        accountId,
        amount: { value: centsToDollars(grossCents), currency: row.currency ?? "USD" },
        meta: {
          provider: "Fygaro",
          transactionId,
          username: account.username ?? "",
          creditStatus: creditResult.status,
          net: centsToDollars(fees.netCents),
          retry: "stranded-credit-sweep",
        },
      })

      // Same once-per-payment announce guard the webhook uses, under the same
      // key, so a customer never sees "+$X added" twice for one top-up.
      const pushClaim = await LockService().lockIdempotencyKey(
        `fygaro-credit-push:${transactionId}` as IdempotencyKey,
      )
      if (!(pushClaim instanceof Error)) {
        await sendFygaroTopupNotificationBestEffort({
          accountId,
          outcome: creditResult.status === "pending" ? "crediting" : "credited",
          amountCents: fees.netCents,
          currency: row.currency ?? "USD",
        })
      }
    }

    baseLogger.info({ summary }, "Fygaro stranded-credit sweep finished")
    return summary
  } catch (err) {
    baseLogger.error({ err, summary }, "Fygaro stranded-credit sweep errored")
    return summary
  }
}
