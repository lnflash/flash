/**
 * Bridge Deposit Webhook Handler
 * Handles deposit.completed events from Bridge.xyz
 *
 * NOTE: This handler only logs the deposit event.
 * The actual balance crediting happens when IBEX sends its crypto.received webhook.
 */

import { Request, Response } from "express"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"

export const depositHandler = async (req: Request, res: Response) => {
  const { event, data } = req.body
  const { transfer_id, amount, currency, tx_hash, customer_id } = data

  if (!transfer_id || !event) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  // Idempotency check using transfer_id as lock key
  const lockKey = `bridge-deposit:${transfer_id}`
  const lockResult = await LockService().lockIdempotencyKey(lockKey as any)
  if (lockResult instanceof Error) {
    baseLogger.info({ transfer_id }, "Duplicate Bridge deposit webhook")
    return res.status(200).json({ status: "already_processed" })
  }

  try {
    // Log deposit event
    // The actual balance crediting happens via IBEX crypto webhook
    baseLogger.info(
      {
        transfer_id,
        amount,
        currency,
        tx_hash,
        customer_id,
        event,
      },
      "Bridge deposit completed",
    )

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, transfer_id }, "Error processing Bridge deposit webhook")
    return res.status(500).json({ error: "Internal server error" })
  }
}
