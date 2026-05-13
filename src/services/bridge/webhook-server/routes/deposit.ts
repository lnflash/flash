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
  const { event_id, event_object } = req.body
  const { id, amount, deposit_id, currency, subtotal_amount, customer_id, receipt } = event_object

  if (!id || !event_id) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  // Idempotency check using deposit_id as lock key
  const lockKey = `bridge-deposit:${deposit_id}`
  const lockResult = await LockService().lockIdempotencyKey(lockKey as any)
  if (lockResult instanceof Error) {
    baseLogger.info({ event_id, id }, "Duplicate Bridge deposit webhook")
    return res.status(200).json({ status: "already_processed" })
  }

  try {
    // Log deposit event
    // The actual balance crediting happens via IBEX crypto webhook
    baseLogger.info(
      {
        id,
        amount,
        initial_amount: receipt.initial_amount,
        currency,
        deposit_id,
        receipt: {
          url: receipt.url,
          initial_amount: receipt.initial_amount,
          subtotal_amount: receipt.subtotal_amount,
          final_amount: receipt.final_amount,
          exchange_fee: receipt.exchange_fee,
          gas_fee: receipt.gas_fee,
        },
        customer_id,
        event_id,

      },
      "Bridge deposit completed",
    )

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, id, event_id, deposit_id }, "Error processing Bridge deposit webhook")
    return res.status(500).json({ error: "Internal server error" })
  }
}
