/**
 * Bridge Transfer Webhook Handler
 * Handles transfer webhook events from Bridge.xyz (transfer.completed, transfer.updated.status_transitioned)
 */

import { Request, Response } from "express"
import { sendBridgeWithdrawalNotificationBestEffort } from "@app/bridge/send-withdrawal-notification"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { toBridgeTransferId } from "@domain/primitives/bridge"
import {
  writeBridgeCashoutCompleted,
  writeBridgeCashoutFailed,
} from "@services/frappe/BridgeTransferRequestWriter"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"

const TERMINAL_FAILURE_STATES = new Set([
  "undeliverable",
  "returned",
  "refunded",
  "refund_failed",
  "missing_return_policy",
  "error",
  "canceled",
])

const TRANSIENT_STATES = new Set(["refund_in_flight"])

const transferLockKey = (
  transferId: string,
  event: string,
  state: string | undefined,
): IdempotencyKey =>
  `bridge-transfer:${transferId}:${event}:${state ?? ""}` as IdempotencyKey

const markProcessed = async (
  transferId: string,
  event: string,
  state: string | undefined,
): Promise<"success" | "already_processed"> => {
  const lockResult = await LockService().lockIdempotencyKey(
    transferLockKey(transferId, event, state),
  )
  if (lockResult instanceof Error) return "already_processed"
  return "success"
}

export const transferHandler = async (req: Request, res: Response) => {
  // Bridge webhook payload: { event_id, event_category, event_type, event_object: { id, state, ... } }
  const { event_type, event_id, event_object } = req.body
  const obj = (event_object ?? {}) as Record<string, unknown>

  // Normalise from Bridge's webhook envelope
  const event = event_type ?? req.body.event
  const transfer_id = (obj.id ?? obj.transfer_id) as string | undefined
  const state = (obj.state ?? obj.status) as string | undefined
  const amount = obj.amount as string | undefined
  const currency = obj.currency as string | undefined
  // Bridge transfer events nest failure reasons in source.details or destination
  const source = obj.source as Record<string, unknown> | undefined
  const destination = obj.destination as Record<string, unknown> | undefined
  const reason = source?.failure_reason as string | undefined
  const return_reason = destination?.return_reason as string | undefined

  if (!transfer_id || !event) {
    baseLogger.warn(
      { event_id, event_category: req.body.event_category, event_type },
      "Bridge transfer webhook rejected: missing transfer_id or event_type",
    )
    return res.status(400).json({ error: "Invalid payload" })
  }

  try {
    const bridgeTransferId = toBridgeTransferId(transfer_id!)

    if (state && TRANSIENT_STATES.has(state)) {
      baseLogger.info(
        { transfer_id, state, event },
        "Bridge transfer in transient state — awaiting terminal event",
      )
      return res.status(200).json({ status: "ignored_transient_state" })
    }

    const isCompletion =
      event === "transfer.completed" ||
      event === "transfer.payment_processed" ||
      state === "payment_processed"

    const isFailure = state != null && TERMINAL_FAILURE_STATES.has(state)

    if (!isCompletion && !isFailure) {
      baseLogger.info(
        { transfer_id, state: state ?? "unknown", event },
        "Bridge transfer event not handled",
      )
      return res.status(200).json({ status: "ignored" })
    }

    if (isCompletion) {
      const result = await BridgeAccountsRepo.updateWithdrawalStatus(
        bridgeTransferId,
        "completed",
      )

      if (result instanceof Error) {
        if (result.message === BridgeAccountsRepo.BRIDGE_WITHDRAWAL_NOT_FOUND) {
          baseLogger.warn(
            { transfer_id },
            "Withdrawal not found for transfer webhook — Bridge may retry after bridgeTransferId is written",
          )
          return res.status(503).json({ error: "Withdrawal not ready" })
        }
        baseLogger.error(
          { transfer_id, error: result },
          "Failed to update withdrawal status",
        )
        return res.status(500).json({ error: "Failed to update status" })
      }

      baseLogger.info(
        {
          transfer_id,
          state,
          amount,
          currency,
        },
        "Bridge transfer completed",
      )

      const auditResult = await writeBridgeCashoutCompleted({
        transferId: transfer_id,
        amount: String(result.amount ?? amount ?? ""),
        currency: String(result.currency ?? currency ?? ""),
        accountId: result.accountId,
        sourceEventId: event_id,
        sourceEventType: event,
        rawPayload: req.body,
      })
      if (auditResult instanceof Error) {
        baseLogger.error(
          { transfer_id, error: auditResult },
          "Failed to persist Bridge transfer ERPNext audit row",
        )
        alertBridge({
          dedupKey: generateDedupKey.erpnextTransferCompletedAudit(transfer_id),
          source: "erpnext-audit",
          severity: "critical",
          title: "Bridge transfer ERPNext audit write failed",
          detail: auditResult.message,
          context: { transfer_id, event },
        })
        return res.status(500).json({ error: "Failed to persist ERPNext audit row" })
      }

      const lockStatus = await markProcessed(transfer_id, event, state)
      if (lockStatus === "already_processed") {
        return res.status(200).json({ status: "already_processed" })
      }

      notifyOpsEvent({
        flow: "transfer",
        phase: "succeeded",
        status: "success",
        accountId: result.accountId,
        amount: {
          value: String(result.amount ?? amount ?? ""),
          currency: String(result.currency ?? currency ?? ""),
        },
        meta: { transferId: transfer_id },
      })

      await sendBridgeWithdrawalNotificationBestEffort({
        accountId: result.accountId,
        amount: result.amount,
        currency: result.currency,
        outcome: "completed",
      })
    } else if (isFailure) {
      const failureReason =
        state === "refund_failed"
          ? (return_reason as string | undefined)
          : ((reason as string | undefined) ?? (return_reason as string | undefined))

      const result = await BridgeAccountsRepo.updateWithdrawalStatus(
        bridgeTransferId,
        "failed",
        failureReason,
      )

      if (result instanceof Error) {
        if (result.message === BridgeAccountsRepo.BRIDGE_WITHDRAWAL_NOT_FOUND) {
          baseLogger.warn(
            { transfer_id },
            "Withdrawal not found for transfer webhook — Bridge may retry after bridgeTransferId is written",
          )
          return res.status(503).json({ error: "Withdrawal not ready" })
        }
        if (result.message.startsWith("Withdrawal already ")) {
          baseLogger.info(
            { transfer_id, state, error: result.message },
            "Ignoring Bridge transfer failure — withdrawal already terminal",
          )
          return res.status(200).json({ status: "already_terminal" })
        }
        baseLogger.error(
          { transfer_id, error: result },
          "Failed to update withdrawal status",
        )
        return res.status(500).json({ error: "Failed to update status" })
      }

      baseLogger.warn(
        {
          transfer_id,
          state,
          amount,
          currency,
          reason,
          return_reason,
        },
        "Bridge transfer failed",
      )

      const auditResult = await writeBridgeCashoutFailed({
        transferId: transfer_id,
        amount: String(result.amount ?? amount ?? ""),
        currency: String(result.currency ?? currency ?? ""),
        accountId: result.accountId,
        sourceEventId: event_id,
        sourceEventType: event,
        failureReason: result.failureReason ?? failureReason,
        rawPayload: req.body,
      })
      if (auditResult instanceof Error) {
        baseLogger.error(
          { transfer_id, error: auditResult },
          "Failed to persist Bridge transfer failure ERPNext audit row",
        )
        alertBridge({
          dedupKey: generateDedupKey.erpnextTransferFailedAudit(transfer_id),
          source: "erpnext-audit",
          severity: "critical",
          title: "Bridge transfer-failure ERPNext audit write failed",
          detail: auditResult.message,
          context: { transfer_id, event },
        })
        return res.status(500).json({ error: "Failed to persist ERPNext audit row" })
      }

      const lockStatus = await markProcessed(transfer_id, event, state)
      if (lockStatus === "already_processed") {
        return res.status(200).json({ status: "already_processed" })
      }

      notifyOpsEvent({
        flow: "transfer",
        phase: "failed",
        status: "failed",
        accountId: result.accountId,
        error: result.failureReason ?? failureReason ?? state,
        amount: {
          value: String(result.amount ?? amount ?? ""),
          currency: String(result.currency ?? currency ?? ""),
        },
        meta: { transferId: transfer_id },
      })

      await sendBridgeWithdrawalNotificationBestEffort({
        accountId: result.accountId,
        amount: result.amount,
        currency: result.currency,
        outcome: "failed",
        failureReason: result.failureReason ?? failureReason,
      })
    }

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, transfer_id }, "Error processing Bridge transfer webhook")
    alertBridge({
      dedupKey: generateDedupKey.bridgeWebhookTransfer(transfer_id, event),
      source: "bridge-webhook",
      severity: "critical",
      title: "Bridge transfer webhook processing error",
      detail: error instanceof Error ? error.message : String(error),
      context: { transfer_id, event },
    })
    return res.status(500).json({ error: "Internal server error" })
  }
}
