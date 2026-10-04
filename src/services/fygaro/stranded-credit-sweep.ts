import { FygaroConfig } from "@config"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import {
  completeFygaroTopup,
  countAgedOutUncreditedFygaroTopups,
  listUncreditedFygaroTopupsLastDays,
  markFygaroTopupNotCredited,
  readFygaroTopupCompletion,
  sumFygaroTopupGrossCentsLast24h,
} from "@services/frappe/BridgeTransferRequestWriter"
import { getFlashFeeDiscountPercent } from "@services/frappe/fee-discounts"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import { sendFygaroTopupNotificationBestEffort } from "@app/fygaro/send-topup-notification"

import { parseCustomReference } from "./checkout"
import { recordIntentOutcome } from "./checkout-intent-store"
import { markFygaroCredited, readFygaroCreditedMarker } from "./credited-marker"
import {
  creditFygaroTopup,
  FygaroCreditError,
  INSUFFICIENT_TREASURY_FLOAT_STEP,
} from "./webhook-server/credit-topup"
import { evaluateCreditGate } from "./webhook-server/fees"
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
 *   - the processed markers are read FIRST — the ERPNext row (ops may have
 *     hand-completed it) AND the Redis credited marker (a prior credit whose
 *     promotion failed) — before the gate or the coverage check, so a paid
 *     row is never re-judged with today's inputs, never stamped as refused,
 *     never reported uncovered, and never sent twice; a marked-but-not-
 *     Completed row pages critical ("promote by hand"),
 *   - the FULL webhook gate is re-run (evaluateCreditGate over the live
 *     settings, the account level, the trailing-24h gross and the operator
 *     fee-discount whitelist), so the fee math and every limit have exactly
 *     one owner,
 *   - the send is creditFygaroTopup, idempotent on `fygaro:<transactionId>`,
 *     so even a lost race with a concurrent webhook retry cannot double-pay,
 *   - on success the row is promoted exactly as the webhook promotes it (full
 *     fee split, so the admin never shows "Pending" fees on a credited row),
 *     the checkout intent (when the payload carries one) is stamped credited
 *     so `fygaroTopupStatus` agrees with the push, and the customer is told
 *     once.
 *
 * Why the daily cap IS re-applied. The candidate shape is not only "credit
 * failed on float": payment.ts answers 500 with no stamp for the transient
 * `settings-unavailable` / `history-unavailable` refusals, so a row can reach
 * this list having never passed the cap at all. Crediting it blind could put a
 * customer over a compliance cap with no refusal row and no alert. A refusal
 * here does what the webhook's refusal does — stamps a failure_reason and
 * pages ops — which is handing the payment to a human, not stranding it.
 *
 * Never retried: rows with a failure_reason (every gate refusal), rows with no
 * account_id (unattributed), email-attributed rows. Non-float failures
 * (`intraledger-send`, unresolvable recipient wallet) alert per payment and
 * are left for the next sweep; a float failure stops the sweep — the balance
 * the caller read is stale and nothing else will fit either.
 *
 * A credit whose ERPNext promotion fails is NOT retried by re-sending. The
 * money moved; the Redis marker records that, the alert is CRITICAL and names
 * the manual step (promote the row by hand), and the next sweep skips the row.
 * The idempotency cache the send relies on lives 24h; the lookback is 7 days
 * and the marker outlives both (credited-marker.ts).
 *
 * Aging out is never silent. Candidates are windowed on `last_seen_at`, which
 * a skipped or failed retry never touches, so a row that fails every tick for
 * `lookbackDays` (or sits uncovered through a slow refill) drops out of the
 * list on day lookback+1 — and with it the per-row warning. The money is still
 * captured and undelivered, so every sweep also counts the rows OLDER than the
 * window with the same shape and pages CRITICAL once per dedup window with the
 * count and the oldest request_id: "credit by hand".
 */

export type StrandedCreditSweepSummary = {
  candidates: number
  credited: number
  // Already credited by someone else: the ERPNext row is Completed, or the
  // Redis credited marker says a prior credit landed and only the promotion
  // failed.
  skippedCompleted: number
  uncovered: number
  failed: number
  // Rows this sweep will never credit and that a human now owns: no usable
  // transaction id / account, or refused by the credit gate (stamped with the
  // reason and alerted, exactly as the webhook refuses).
  leftForManual: number
  stoppedOnFloat: boolean
  // Stranded rows older than the lookback window: the sweep can no longer see
  // them as candidates and will never retry them. Paged critical, never
  // silently dropped.
  agedOut: number
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

// The checkout intent id the webhook stamped outcomes on, when the payment was
// authorised through signed checkout. Read back off the audit row's stored
// payload: `customReference` is `<username>|<intentId>` in that case (see
// checkout.ts buildCustomReference). Absent for every legacy bare-username
// payment, and for a payload the sweep could not parse.
const intentIdOf = (rawPayload: unknown): string | undefined => {
  if (!rawPayload || typeof rawPayload !== "object") return undefined
  const customReference = (rawPayload as { customReference?: unknown }).customReference
  if (typeof customReference !== "string") return undefined
  return parseCustomReference(customReference)?.intentId
}

const transactionIdOf = (requestId: string): string | undefined =>
  requestId.startsWith("fygaro:") ? requestId.slice("fygaro:".length) : undefined

const emptySummary = (): StrandedCreditSweepSummary => ({
  candidates: 0,
  credited: 0,
  skippedCompleted: 0,
  uncovered: 0,
  failed: 0,
  leftForManual: 0,
  stoppedOnFloat: false,
  agedOut: 0,
})

// Rows that fell out of the window uncredited and unrefused. Runs after every
// sweep — including one with no candidates, which is exactly what a fully
// aged-out backlog looks like. A failed count is a warning, not a page: the
// list read that just succeeded makes a transient blip the likely cause, and
// the next tick re-counts.
const pageAgedOutStrandedTopups = async ({
  lookbackDays,
  summary,
}: {
  lookbackDays: number
  summary: StrandedCreditSweepSummary
}): Promise<void> => {
  const aged = await countAgedOutUncreditedFygaroTopups({ days: lookbackDays })
  if (aged instanceof Error) {
    baseLogger.warn(
      { err: aged, lookbackDays },
      "Fygaro stranded-credit sweep: could not count aged-out stranded top-ups",
    )
    return
  }
  summary.agedOut = aged.count
  if (aged.count === 0) return
  baseLogger.error(
    {
      agedOut: aged.count,
      lookbackDays,
      oldestRequestId: aged.oldestRequestId,
      oldestLastSeenAt: aged.oldestLastSeenAt,
    },
    "Fygaro stranded-credit sweep: stranded top-ups older than the lookback will never be retried — credit by hand",
  )
  alertBridge({
    dedupKey: generateDedupKey.fygaroRetryAgedOut(),
    source: "fygaro-webhook",
    severity: "critical",
    title: `Fygaro stranded-credit sweep aged out ${aged.count} stranded top-up${aged.count === 1 ? "" : "s"} — credit by hand`,
    detail: `${aged.count} Fiat Received Fygaro top-up${aged.count === 1 ? "" : "s"} with no failure_reason ${aged.count === 1 ? "is" : "are"} older than the ${lookbackDays}-day lookback and will not be retried; oldest=${aged.oldestRequestId ?? "unknown"} last_seen_at=${aged.oldestLastSeenAt ?? "unknown"}`,
    context: {
      aged_out: aged.count,
      lookback_days: lookbackDays,
      oldest_request_id: aged.oldestRequestId ?? "",
      oldest_last_seen_at: aged.oldestLastSeenAt ?? "",
    },
  })
}

/**
 * @param availableUsd what the caller will let this sweep spend: the treasury
 *   balance it just read MINUS the critical-floor reserve kept for live card
 *   traffic (treasury-loop.ts). Candidates whose net exceeds what is left are
 *   reported `uncovered` (warning) and skipped, so a $400 payment never blocks
 *   a $20 one behind it.
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
    if (rows.length === 0) {
      await pageAgedOutStrandedTopups({ lookbackDays, summary })
      return summary
    }

    let remainingUsd = availableUsd

    for (const row of rows) {
      const transactionId = transactionIdOf(row.request_id)
      if (!transactionId || !row.account_id) {
        summary.leftForManual += 1
        baseLogger.warn(
          { requestId: row.request_id, accountId: row.account_id },
          "Fygaro stranded-credit sweep: row has no fygaro transaction id or no account, leaving for manual",
        )
        continue
      }
      const accountId = row.account_id as AccountId
      const currency = row.currency ?? "USD"

      // Processed markers FIRST, before any gate or coverage check. The row
      // we are about to re-judge may already have been paid: ops may have hand-
      // credited and marked it Completed since the list was fetched, or an
      // earlier credit (this sweep's or the webhook's) landed and only the
      // promotion failed. Re-running the gate on a paid row with today's
      // inputs (a lowered cap, a raised minimum, a downgraded level) would
      // stamp `daily-limit-exceeded` on money the customer already has, drop
      // it out of the allowance sum and announce a contradiction; re-running
      // the coverage check would re-raise "uncovered" every tick for a payment
      // that needs no float at all. So neither runs until both markers say
      // this row is genuinely unpaid.
      const completion = await readFygaroTopupCompletion(transactionId)
      if (completion.completed) {
        summary.skippedCompleted += 1
        baseLogger.info(
          { transactionId },
          "Fygaro stranded-credit sweep: row already Completed, skipping",
        )
        continue
      }

      // Second marker, independent of ERPNext: a prior credit whose promotion
      // failed. The row still reads Fiat Received, the send cache is only 24h
      // — re-sending would be a second payment. Unknown (Redis unreadable) is
      // also a stop: wait a tick.
      const marker = await readFygaroCreditedMarker(transactionId)
      if (!marker.known) {
        summary.failed += 1
        baseLogger.warn(
          { transactionId },
          "Fygaro stranded-credit sweep: credited marker unreadable, not sending this tick",
        )
        continue
      }
      if (marker.credited) {
        // Money is in the wallet; the audit row never got promoted. Nothing
        // here re-sends (that would be a double-pay) and Fygaro never retries
        // a 200, so nothing self-heals: this is a page, not a log line. Same
        // dedup key as the promotion-failure alerts, so it joins that incident
        // rather than opening a second one every 15 minutes.
        summary.skippedCompleted += 1
        const markerNetUsd = marker.netCents != null ? marker.netCents / 100 : undefined
        baseLogger.warn(
          { transactionId, netCents: marker.netCents },
          "Fygaro stranded-credit sweep: already credited (marker) but row not Completed — promote by hand, not re-sending",
        )
        alertBridge({
          dedupKey: generateDedupKey.erpnextFygaroAudit(transactionId),
          source: "erpnext-audit",
          severity: "critical",
          title: "Fygaro top-up credited but row not Completed — promote the row by hand",
          detail: `net=${markerNetUsd != null ? `$${markerNetUsd.toFixed(2)}` : "unknown"} already credited to ${accountId}; row still Fiat Received, sweep will not re-send or re-promote`,
          context: {
            transaction_id: transactionId,
            account_id: accountId,
            net_usd: markerNetUsd,
          },
        })
        continue
      }

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

      const account = await AccountsRepository().findById(accountId)
      if (account instanceof Error) {
        baseLogger.warn(
          { transactionId, accountId, err: account },
          "Fygaro stranded-credit sweep: account lookup failed, skipping",
        )
        summary.failed += 1
        continue
      }

      // The real gate, with the real inputs, exactly as payment.ts runs it.
      // Trailing-24h gross EXCLUDING this row (it is already in the sum as a
      // Fiat Received row). A failed history read stays undefined so the gate
      // reports `history-unavailable` rather than treating an outage as a
      // clean slate.
      const priorSum = await sumFygaroTopupGrossCentsLast24h({
        accountId,
        excludeTransactionId: transactionId,
      })
      const priorDayGrossCents = priorSum instanceof Error ? undefined : priorSum
      const flashFeeDiscountPercent = await getFlashFeeDiscountPercent({
        username: account.username,
        flow: "topup",
      })
      const gate = evaluateCreditGate({
        creditEnabled: true,
        currency,
        settings,
        grossCents,
        level: account.level,
        priorDayGrossCents,
        flashFeeDiscountPercent,
      })

      if (!gate.credit) {
        if (
          gate.reason === "settings-unavailable" ||
          gate.reason === "history-unavailable"
        ) {
          // Transient (an ERPNext blip). Same stance as the webhook: no stamp,
          // retry next tick once the read self-heals.
          summary.failed += 1
          baseLogger.warn(
            { transactionId, reason: gate.reason },
            "Fygaro stranded-credit sweep: ERPNext read unavailable, retrying next sweep",
          )
          continue
        }

        // Deterministic refusal: hand it to a human the way the webhook does.
        // Stamping the reason takes the row out of the daily-allowance sum (an
        // uncredited payment delivered no value) and out of this list.
        summary.leftForManual += 1
        baseLogger.info(
          { transactionId, reason: gate.reason, grossCents, level: account.level },
          "Fygaro stranded-credit sweep: refused by the credit gate, leaving for manual",
        )
        alertBridge({
          dedupKey: generateDedupKey.fygaroNotCredited(transactionId),
          source: "fygaro-webhook",
          severity: "warning",
          title: `Fygaro stranded top-up refused on retry (${gate.reason}) — not auto-credited`,
          detail: `reason=${gate.reason} currency=${currency} gross=${centsToDollars(grossCents)} level=${account.level} retry=stranded-credit-sweep`,
          context: {
            transaction_id: transactionId,
            account_id: accountId,
            amount: centsToDollars(grossCents),
            reason: gate.reason,
            username: account.username ?? "",
            account_level: account.level,
          },
        })
        const marked = await markFygaroTopupNotCredited({
          transactionId,
          accountId,
          amount: centsToDollars(grossCents),
          currency,
          reason: gate.reason,
          rawPayload: parseRawPayload(row.raw_payload_json),
        })
        if (marked instanceof Error) {
          baseLogger.error(
            { transactionId, reason: gate.reason, err: marked },
            "Fygaro stranded-credit sweep: could not stamp the refusal on the audit row",
          )
          alertBridge({
            dedupKey: generateDedupKey.fygaroRefusalNotStamped(transactionId),
            source: "erpnext-audit",
            severity: "critical",
            title:
              "Fygaro stranded top-up refused but ERPNext could not be stamped — stamp failure_reason by hand",
            detail: `reason=${gate.reason}: ${marked.message}`,
            context: { transaction_id: transactionId, reason: gate.reason },
          })
        }
        continue
      }

      const { fees } = gate
      const netUsd = fees.netCents / 100
      if (netUsd > remainingUsd) {
        summary.uncovered += 1
        alertBridge({
          dedupKey: generateDedupKey.fygaroRetryUncovered(transactionId),
          source: "fygaro-webhook",
          severity: "warning",
          title:
            "Fygaro stranded top-up still uncovered — treasury float too low to retry",
          detail: `net=$${centsToDollars(fees.netCents)} available above reserve=$${remainingUsd.toFixed(2)}`,
          context: {
            transaction_id: transactionId,
            account_id: accountId,
            net_usd: netUsd,
            available_usd: remainingUsd,
          },
        })
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

      // Money moved. Record that durably BEFORE anything that can fail or
      // announce, so no later sweep can mistake this row for stranded.
      await markFygaroCredited({ transactionId, netCents: fees.netCents })

      remainingUsd -= netUsd
      summary.credited += 1

      const rawPayload = parseRawPayload(row.raw_payload_json)
      const completeResult = await completeFygaroTopup({
        transactionId,
        accountId,
        walletId: creditResult.walletId,
        amount: centsToDollars(grossCents),
        currency,
        initialAmount: centsToDollars(fees.grossCents),
        processorFee: centsToDollars(fees.processorFeeCents),
        flashFee: centsToDollars(fees.flashFeeCents),
        finalAmount: centsToDollars(fees.netCents),
        rawPayload,
      })
      if (completeResult instanceof Error) {
        // Money moved; only the promotion failed. The credited marker above
        // keeps every later sweep off this row, so nothing re-sends — which
        // also means nothing self-heals. Only a human can finish it.
        baseLogger.error(
          { transactionId, accountId, err: completeResult },
          "Fygaro stranded-credit sweep: credit succeeded but ERPNext promotion failed",
        )
        alertBridge({
          dedupKey: generateDedupKey.erpnextFygaroAudit(transactionId),
          source: "erpnext-audit",
          severity: "critical",
          title:
            "Fygaro retry credit succeeded but ERPNext promotion failed — money moved, promote the row by hand",
          detail: `net=$${centsToDollars(fees.netCents)} credited to ${accountId}; row still Fiat Received: ${completeResult.message}`,
          context: {
            transaction_id: transactionId,
            account_id: accountId,
            net_usd: netUsd,
          },
        })
      }

      // The webhook stamps the checkout intent so `fygaroTopupStatus` tells
      // the app the money landed; a swept payment must say the same thing or
      // the app keeps polling FAILED while the push says credited. Only for
      // payments that carried an intent (signed checkout); legacy payloads
      // have nothing to stamp.
      const intentId = intentIdOf(rawPayload)
      if (intentId) {
        await recordIntentOutcome({
          intentId,
          outcome: {
            state: "credited",
            netAmountCents: fees.netCents,
            transactionId,
            atMs: Date.now(),
          },
          ttlSeconds: FygaroConfig.checkout?.ttlSeconds ?? 900,
        })
      }

      notifyOpsEvent({
        flow: "deposit",
        phase: "succeeded",
        status: "success",
        accountId,
        amount: { value: centsToDollars(grossCents), currency },
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
          currency,
        })
      }
    }

    await pageAgedOutStrandedTopups({ lookbackDays, summary })
    baseLogger.info({ summary }, "Fygaro stranded-credit sweep finished")
    return summary
  } catch (err) {
    baseLogger.error({ err, summary }, "Fygaro stranded-credit sweep errored")
    return summary
  }
}
