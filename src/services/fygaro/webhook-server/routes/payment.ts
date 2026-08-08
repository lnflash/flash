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
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import {
  writeFygaroTopupRequest,
  completeFygaroTopup,
} from "@services/frappe/BridgeTransferRequestWriter"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"

import { creditFygaroTopup, FygaroCreditError } from "../credit-topup"

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

    // Mark processed only after the audit write succeeds, so provider retries
    // can recover audit gaps after transient persistence failures. Everything
    // past this point runs at most once per transaction.
    const lockResult = await LockService().lockIdempotencyKey(
      `fygaro-payment:${transactionId}` as IdempotencyKey,
    )
    if (lockResult instanceof Error) {
      baseLogger.info({ transactionId }, "Duplicate Fygaro payment webhook")
      return res.status(200).json({ status: "already_processed" })
    }

    if (!FygaroConfig.credit?.enabled || currency !== "USD") {
      if (currency !== "USD") {
        // The payment button is USD-only; a non-USD payment is unexpected
        // enough to demand human eyes before any crediting.
        alertBridge({
          dedupKey: generateDedupKey.fygaroCreditFailed(transactionId),
          source: "fygaro-webhook",
          severity: "warning",
          title: "Fygaro payment in unexpected currency — not auto-credited",
          detail: `currency=${currency}`,
          context: { transaction_id: transactionId, amount: String(payload.amount) },
        })
      }
      notifyOpsEvent({
        flow: "deposit",
        phase: "fygaro-recorded",
        status: "pending",
        accountId,
        amount: { value: String(payload.amount), currency },
        meta: { provider: "Fygaro", transactionId, username: username ?? "" },
      })
      return res.status(200).json({ status: "recorded", credited: false })
    }

    const amountCents = Math.round(Number(payload.amount) * 100)
    const creditResult = await creditFygaroTopup({
      recipientAccountId: accountId,
      amountCents,
      transactionId,
    })
    if (creditResult instanceof FygaroCreditError) {
      baseLogger.error(
        { error: creditResult, transactionId, accountId },
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
          account_id: accountId,
          amount: String(payload.amount),
        },
      })
      notifyOpsEvent({
        flow: "deposit",
        phase: "failed",
        status: "failed",
        step: `credit:${creditResult.step}`,
        error: creditResult.constructor.name,
        accountId,
        amount: { value: String(payload.amount), currency },
        meta: { provider: "Fygaro", transactionId, username: username ?? "" },
      })
      // The payment IS recorded; a 500 would only re-run the (now locked)
      // handler. Ops resolves the credit manually from the alert.
      return res.status(200).json({ status: "recorded", credited: false })
    }

    const completeResult = await completeFygaroTopup({
      transactionId,
      accountId,
      walletId: creditResult.walletId,
      amount: String(payload.amount),
      currency,
      rawPayload: req.body,
    })
    if (completeResult instanceof Error) {
      // The money moved; only the audit promotion failed. Alert, don't fail.
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
      accountId,
      amount: { value: String(payload.amount), currency },
      meta: {
        provider: "Fygaro",
        transactionId,
        username: username ?? "",
        creditStatus: creditResult.status,
      },
    })

    return res.status(200).json({ status: "success", credited: true })
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
