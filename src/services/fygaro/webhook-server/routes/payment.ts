/**
 * Fygaro Payment Webhook Handler
 * Handles payment notifications from Fygaro's payment-button hook.
 *
 * A payment here is fiat that has already been captured on Fygaro's side
 * (card or PayPal). The handler:
 *   1. attributes the payment to a Flash account via customReference
 *      (the app sends the Flash username there — see flash-mobile
 *      CardPayment.tsx),
 *   2. writes the ERPNext audit row (Bridge Transfer Request,
 *      provider=Fygaro) so every card top-up is recorded,
 *   3. posts to the ops activity feed, and
 *   4. when fygaro.credit.enabled: credits the user's cash wallet from the
 *      bank-owner treasury (idempotent on the Fygaro transaction id).
 *
 * Unattributed payments (blank/unknown customReference — every pre-fix app
 * build sends a blank one) are still recorded and alerted so ops can resolve
 * them manually; they are never silently dropped.
 */

import { Request, Response } from "express"

import { FygaroConfig } from "@config"
import { ResourceAttemptsLockServiceError } from "@domain/lock"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import {
  writeFygaroTopupRequest,
  completeFygaroTopup,
  isFygaroTopupCompleted,
} from "@services/frappe/BridgeTransferRequestWriter"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"

import { creditFygaroTopup, FygaroCreditError } from "../credit-topup"
import { getFygaroSettings } from "../fygaro-settings"
import { evaluateCreditGate, RecordOnlyReason } from "../fees"

type FygaroPaymentPayload = {
  transactionId?: string
  reference?: string
  customReference?: string | null
  amount?: string
  currency?: string
  authCode?: string | null
  createdAt?: string
  client?: { name?: string; email?: string }
}

const centsToDollars = (cents: number): string => (cents / 100).toFixed(2)

// Human-readable title for the single record-only ops alert. `credit-disabled`
// is intentionally absent — that is the deploy-level master gate and records
// silently (no anomaly worth paging on).
const RECORD_ONLY_ALERT_TITLE: Record<
  Exclude<RecordOnlyReason, "credit-disabled">,
  string
> = {
  "settings-unavailable":
    "Fygaro Settings unavailable — payment recorded, not auto-credited",
  "auto-credit-disabled":
    "Fygaro auto-credit disabled in settings — payment recorded, not auto-credited",
  "non-usd": "Fygaro payment in unexpected currency — not auto-credited",
  "over-limit": "Fygaro payment over the auto-credit limit — not auto-credited",
  "non-positive-net": "Fygaro payment net after fees is not positive — not auto-credited",
}

export const paymentHandler = async (req: Request, res: Response) => {
  const payload = (req.body ?? {}) as FygaroPaymentPayload
  const { transactionId, createdAt } = payload
  const currency = (payload.currency ?? "USD").toUpperCase()
  const username = payload.customReference?.trim() || undefined

  if (!transactionId || !payload.amount) {
    baseLogger.warn(
      { transactionId, has_amount: Boolean(payload.amount) },
      "Fygaro payment webhook rejected: missing required fields",
    )
    return res.status(400).json({
      error: "Invalid payload",
      detail: "Missing one or more required fields: transactionId, amount",
    })
  }

  try {
    baseLogger.info(
      {
        transactionId,
        amount: payload.amount,
        currency,
        username,
        reference: payload.reference,
      },
      "Fygaro payment event",
    )

    // Attribution: customReference carries the Flash username. A blank or
    // unknown reference still gets recorded — that IS the failure mode this
    // webhook exists to surface.
    let accountId: AccountId | undefined
    if (username) {
      const account = await AccountsRepository().findByUsername(username as Username)
      if (account instanceof Error) {
        baseLogger.warn(
          { transactionId, username },
          "Fygaro payment: customReference does not match any account",
        )
      } else {
        accountId = account.id
      }
    }

    const auditResult = await writeFygaroTopupRequest({
      transactionId,
      amount: String(payload.amount),
      currency,
      accountId,
      createdAt,
      rawPayload: req.body,
    })
    if (auditResult instanceof Error) {
      baseLogger.error(
        { error: auditResult, transactionId },
        "Failed to persist Fygaro ERPNext audit row",
      )
      alertBridge({
        dedupKey: generateDedupKey.erpnextFygaroAudit(transactionId),
        source: "erpnext-audit",
        severity: "critical",
        title: "Fygaro payment ERPNext audit write failed",
        detail: auditResult.message,
        context: { transaction_id: transactionId },
      })
      notifyOpsEvent({
        flow: "deposit",
        phase: "failed",
        status: "failed",
        step: "erpnext-audit",
        error: auditResult.constructor.name,
        amount: { value: String(payload.amount), currency },
        meta: { provider: "Fygaro", transactionId },
      })
      // 500 so Fygaro retries and the audit gap can self-heal.
      return res.status(500).json({ error: "Failed to persist audit row" })
    }

    if (!accountId) {
      // Dedupe re-deliveries before emitting: alertBridge is TTL-deduped but
      // the ops feed is not, so a Fygaro retry of an unattributed payment
      // would otherwise spam a feed line per delivery. Taken only after the
      // audit write succeeds so retries can still repair transient failures.
      const dedupe = await LockService().lockIdempotencyKey(
        `fygaro-payment:${transactionId}` as IdempotencyKey,
      )
      if (dedupe instanceof Error) {
        baseLogger.info({ transactionId }, "Duplicate Fygaro payment webhook")
        return res.status(200).json({ status: "already_processed" })
      }
      alertBridge({
        dedupKey: generateDedupKey.fygaroUnattributed(transactionId),
        source: "fygaro-webhook",
        severity: "warning",
        title: "Fygaro payment could not be attributed to an account",
        detail: `customReference=${username ?? "<blank>"} — manual attribution needed`,
        context: {
          transaction_id: transactionId,
          amount: String(payload.amount),
          client_email: payload.client?.email,
        },
      })
      notifyOpsEvent({
        flow: "deposit",
        phase: "fygaro-unattributed",
        status: "pending",
        amount: { value: String(payload.amount), currency },
        meta: {
          provider: "Fygaro",
          transactionId,
          reference: username ?? "blank",
          email: payload.client?.email ?? "unknown",
        },
      })
      return res.status(200).json({ status: "recorded", attributed: false })
    }

    // Fee-aware gate: credit the NET (gross minus processor + Flash fees), and
    // only when every gate holds. The fees/threshold/minimum/toggle live in the
    // ERPNext "Fygaro Settings" doctype, read through a 60s cache; the yaml
    // FygaroConfig.credit.enabled stays the deploy-level master gate. Settings
    // are only read when credit is enabled — a disabled deploy never touches
    // ERPNext for this.
    const creditEnabled = Boolean(FygaroConfig.credit?.enabled)
    const grossCents = Math.round(Number(payload.amount) * 100)
    const settings = creditEnabled ? await getFygaroSettings() : undefined
    const gate = evaluateCreditGate({ creditEnabled, currency, settings, grossCents })

    if (!gate.credit) {
      // Record-only path: nothing money-moving happens here, so a
      // non-releasing timelock is the right dedupe. Taken only after the
      // audit write succeeds so provider retries can recover audit gaps
      // after transient persistence failures.
      const lockResult = await LockService().lockIdempotencyKey(
        `fygaro-payment:${transactionId}` as IdempotencyKey,
      )
      if (lockResult instanceof Error) {
        baseLogger.info({ transactionId }, "Duplicate Fygaro payment webhook")
        return res.status(200).json({ status: "already_processed" })
      }
      if (gate.reason !== "credit-disabled") {
        // credit-disabled is the deploy-level master gate and records
        // silently. Every other reason means credit IS supposed to be on but
        // this specific payment was skipped — page a human, naming the gate,
        // since it leaves fiat sitting uncredited.
        alertBridge({
          dedupKey: generateDedupKey.fygaroNotCredited(transactionId),
          source: "fygaro-webhook",
          severity: "warning",
          title: RECORD_ONLY_ALERT_TITLE[gate.reason],
          detail: `reason=${gate.reason} currency=${currency} gross=${centsToDollars(grossCents)}`,
          context: {
            transaction_id: transactionId,
            amount: String(payload.amount),
            reason: gate.reason,
          },
        })
      }
      notifyOpsEvent({
        flow: "deposit",
        phase: "fygaro-recorded",
        status: "pending",
        accountId,
        amount: { value: String(payload.amount), currency },
        meta: {
          provider: "Fygaro",
          transactionId,
          username: username ?? "",
          reason: gate.reason,
        },
      })
      return res.status(200).json({ status: "recorded", credited: false })
    }

    // Credit path: serialize deliveries with a RELEASING lock and use the
    // audit row's Completed status as the processed marker. A crash between
    // here and the promotion releases the lock, so the next provider retry
    // re-runs this block — withPaymentIdempotency (keyed fygaro:<txId>) makes
    // the send itself exactly-once — instead of stranding a paid-but-
    // uncredited payment behind a consumed timelock. Distinct resource from
    // the lock withPaymentIdempotency takes internally (that one is scoped to
    // the sender wallet), so there is no nested-acquire collision.
    const creditAccountId = accountId
    const { fees } = gate
    const outcome = await LockService().lockPaymentIdempotencyKey(
      `fygaro-payment:${transactionId}` as IdempotencyKey,
      async () => {
        if (await isFygaroTopupCompleted(transactionId)) {
          baseLogger.info({ transactionId }, "Duplicate Fygaro payment webhook")
          return { code: 200, body: { status: "already_processed" } }
        }

        const creditResult = await creditFygaroTopup({
          recipientAccountId: creditAccountId,
          amountCents: fees.netCents,
          transactionId,
        })
        if (creditResult instanceof FygaroCreditError) {
          baseLogger.error(
            { error: creditResult, transactionId, accountId: creditAccountId },
            "Fygaro payment recorded but auto-credit failed",
          )
          alertBridge({
            dedupKey: generateDedupKey.fygaroCreditFailed(transactionId),
            source: "fygaro-webhook",
            severity: "critical",
            title: "Fygaro auto-credit failed — manual credit needed",
            detail: `${creditResult.step}: ${creditResult.message}`,
            context: {
              transaction_id: transactionId,
              account_id: creditAccountId,
              amount: String(payload.amount),
            },
          })
          notifyOpsEvent({
            flow: "deposit",
            phase: "failed",
            status: "failed",
            step: `credit:${creditResult.step}`,
            error: creditResult.constructor.name,
            accountId: creditAccountId,
            amount: { value: String(payload.amount), currency },
            meta: { provider: "Fygaro", transactionId, username: username ?? "" },
          })
          // The payment IS recorded and the row stays Fiat Received. A failed
          // send is not cached, so a provider retry re-attempts the credit
          // (self-healing for transient failures); ops has the critical alert
          // for the deterministic ones.
          return { code: 200, body: { status: "recorded", credited: false } }
        }

        const completeResult = await completeFygaroTopup({
          transactionId,
          accountId: creditAccountId,
          walletId: creditResult.walletId,
          amount: String(payload.amount),
          currency,
          initialAmount: centsToDollars(fees.grossCents),
          processorFee: centsToDollars(fees.processorFeeCents),
          flashFee: centsToDollars(fees.flashFeeCents),
          finalAmount: centsToDollars(fees.netCents),
          rawPayload: req.body,
        })
        if (completeResult instanceof Error) {
          // The money moved; only the audit promotion failed. Alert, don't
          // fail: the row stays Fiat Received, so a provider retry replays
          // the cached send result and re-attempts this promotion.
          alertBridge({
            dedupKey: generateDedupKey.erpnextFygaroAudit(transactionId),
            source: "erpnext-audit",
            severity: "warning",
            title: "Fygaro credit succeeded but ERPNext promotion failed",
            detail: completeResult.message,
            context: { transaction_id: transactionId },
          })
        }

        notifyOpsEvent({
          flow: "deposit",
          phase: "succeeded",
          status: "success",
          accountId: creditAccountId,
          amount: { value: String(payload.amount), currency },
          meta: {
            provider: "Fygaro",
            transactionId,
            username: username ?? "",
            creditStatus: creditResult.status,
            net: centsToDollars(fees.netCents),
          },
        })

        return { code: 200, body: { status: "success", credited: true } }
      },
    )
    if (outcome instanceof ResourceAttemptsLockServiceError) {
      // Another delivery of this payment holds the credit lock right now.
      baseLogger.info({ transactionId }, "Fygaro payment already being processed")
      return res.status(200).json({ status: "already_processing" })
    }
    if (outcome instanceof Error) {
      // Any other lock error means redlock swallowed a throw from inside the
      // credit block (UnknownLockServiceError). Rethrow so the catch-all
      // below returns 500 + critical alert and Fygaro retries, instead of
      // acking a stranded payment as "already_processing".
      throw outcome
    }
    return res.status(outcome.code).json(outcome.body)
  } catch (error) {
    baseLogger.error({ error, transactionId }, "Error processing Fygaro payment webhook")
    alertBridge({
      dedupKey: generateDedupKey.fygaroWebhookPayment(transactionId),
      source: "fygaro-webhook",
      severity: "critical",
      title: "Fygaro payment webhook processing error",
      detail: error instanceof Error ? error.message : String(error),
      context: { transaction_id: transactionId },
    })
    notifyOpsEvent({
      flow: "deposit",
      phase: "failed",
      status: "failed",
      step: "exception",
      error: error instanceof Error ? error.constructor.name : String(error),
      meta: { provider: "Fygaro", transactionId },
    })
    return res.status(500).json({ error: "Internal server error" })
  }
}
