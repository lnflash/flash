/**
 * Bridge Deposit Webhook Handler
 * Handles transfer state-transition events (deposit flow) from Bridge.xyz
 *
 * NOTE: This handler only logs the deposit event.
 * The actual balance crediting happens when IBEX sends its crypto.received webhook.
 */

import { Request, Response } from "express"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { createBridgeDepositLog } from "@services/mongoose/bridge-deposit-log"

export const depositHandler = async (req: Request, res: Response) => {
  const { event_id, event_object } = req.body
  const { id, state, amount, currency, on_behalf_of, receipt } = event_object ?? {}

  if (!id || !event_id) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  // Idempotency: lock on the transfer id + state so each state transition is processed once
  const lockKey = `bridge-deposit:${id}:${state}`
  const lockResult = await LockService().lockIdempotencyKey(lockKey as any)
  if (lockResult instanceof Error) {
    baseLogger.info({ event_id, id, state }, "Duplicate Bridge deposit webhook")
    return res.status(200).json({ status: "already_processed" })
  }

  try {
    baseLogger.info(
      {
        id,
        state,
        amount,
        currency,
        on_behalf_of,
        receipt: {
          initial_amount: receipt?.initial_amount,
          subtotal_amount: receipt?.subtotal_amount,
          final_amount: receipt?.final_amount,
          developer_fee: receipt?.developer_fee,
          destination_tx_hash: receipt?.destination_tx_hash,
        },
        event_id,
      },
      "Bridge deposit event",
    )

    const depositLog = await createBridgeDepositLog({
      eventId: event_id,
      transferId: id,
      customerId: on_behalf_of ?? "",
      state,
      amount: String(amount),
      currency,
      subtotalAmount: receipt?.subtotal_amount != null ? String(receipt.subtotal_amount) : undefined,
      developerFee: receipt?.developer_fee != null ? String(receipt.developer_fee) : undefined,
      initialAmount: receipt?.initial_amount != null ? String(receipt.initial_amount) : undefined,
      finalAmount: receipt?.final_amount != null ? String(receipt.final_amount) : undefined,
      destinationTxHash: receipt?.destination_tx_hash,
    })

    if (depositLog instanceof Error) {
      baseLogger.error({ error: depositLog, event_id, id }, "Failed to persist bridge deposit log")
      return res.status(500).json({ error: "Failed to persist deposit log" })
    }

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, id, event_id }, "Error processing Bridge deposit webhook")
    return res.status(500).json({ error: "Internal server error" })
  }
}
