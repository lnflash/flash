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
  const { event, data } = req.body
  const { transfer_id, state, amount, currency, reason, return_reason } = data

  if (!transfer_id || !event) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  try {
    const bridgeTransferId = toBridgeTransferId(transfer_id)

    if (TRANSIENT_STATES.has(state)) {
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

    const isFailure = TERMINAL_FAILURE_STATES.has(state)

    if (!isCompletion && !isFailure) {
      baseLogger.info({ transfer_id, state, event }, "Bridge transfer event not handled")
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

      const lockStatus = await markProcessed(transfer_id, event, state)
      if (lockStatus === "already_processed") {
        return res.status(200).json({ status: "already_processed" })
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

      const lockStatus = await markProcessed(transfer_id, event, state)
      if (lockStatus === "already_processed") {
        return res.status(200).json({ status: "already_processed" })
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
    return res.status(500).json({ error: "Internal server error" })
  }
}
