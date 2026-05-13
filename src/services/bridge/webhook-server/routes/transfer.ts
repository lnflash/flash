/**
 * Bridge Transfer Webhook Handler
 * Handles transfer.completed and transfer.failed events from Bridge.xyz
 */

import { Request, Response } from "express"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { toBridgeTransferId } from "@domain/primitives/bridge"

export const transferHandler = async (req: Request, res: Response) => {
  const { event, data } = req.body
  const { transfer_id, state, amount, currency } = data

  if (!transfer_id || !event) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  // Idempotency check using transfer_id as lock key
  const lockKey = `bridge-transfer:${transfer_id}`
  const lockResult = await LockService().lockIdempotencyKey(lockKey as any)
  if (lockResult instanceof Error) {
    baseLogger.info({ transfer_id }, "Duplicate Bridge transfer webhook")
    return res.status(200).json({ status: "already_processed" })
  }

  try {
    const bridgeTransferId = toBridgeTransferId(transfer_id)

    // Update withdrawal status based on event
    if (event === "transfer.completed") {
      const result = await BridgeAccountsRepo.updateWithdrawalStatus(
        bridgeTransferId,
        "completed",
      )

      if (result instanceof Error) {
        baseLogger.error(
          { transfer_id, error: result },
          "Failed to update withdrawal status",
        )
        return res.status(500).json({ error: "Failed to update status" })
      }

      baseLogger.info(
        {
          transfer_id,
          amount,
          currency,
        },
        "Bridge transfer completed",
      )

      // TODO: Send push notification to user
    } else if (event === "transfer.failed") {
      const result = await BridgeAccountsRepo.updateWithdrawalStatus(
        bridgeTransferId,
        "failed",
      )

      if (result instanceof Error) {
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
        },
        "Bridge transfer failed",
      )

      // TODO: Send push notification to user
    }

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, transfer_id }, "Error processing Bridge transfer webhook")
    return res.status(500).json({ error: "Internal server error" })
  }
}
