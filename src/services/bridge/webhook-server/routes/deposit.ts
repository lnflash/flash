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
import { createBridgeDeposit } from "@services/mongoose/bridge-deposit-log"
import { reconcileByTxHash } from "@services/bridge/reconciliation"
import { writeBridgeDepositRequest } from "@services/frappe/BridgeTransferRequestWriter"

export const depositHandler = async (req: Request, res: Response) => {
  const { event_id, event_object } = req.body
  const { id, state, amount, currency, on_behalf_of, receipt } = event_object ?? {}

  if (!id || !event_id || !amount || !on_behalf_of) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  try {
    const lockKey = `bridge-deposit:${id}:${state}`
    const lockResult = await LockService().lockIdempotencyKey(lockKey as IdempotencyKey)
    if (lockResult instanceof Error) {
      baseLogger.info({ event_id, id, state }, "Duplicate Bridge deposit webhook")
      return res.status(200).json({ status: "already_processed" })
    }

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

    const depositLog = await createBridgeDeposit({
      eventId: event_id,
      transferId: id,
      customerId: on_behalf_of,
      state,
      amount: String(amount),
      currency,
      developerFee:
        receipt?.developer_fee != null
          ? String(receipt.developer_fee)
          : event_object?.developer_fee != null
            ? String(event_object.developer_fee)
            : "0.0",
      subtotalAmount:
        receipt?.subtotal_amount != null ? String(receipt.subtotal_amount) : undefined,
      initialAmount:
        receipt?.initial_amount != null ? String(receipt.initial_amount) : undefined,
      finalAmount:
        receipt?.final_amount != null ? String(receipt.final_amount) : undefined,
      destinationTxHash: receipt?.destination_tx_hash,
    })

    if (depositLog instanceof Error) {
      baseLogger.error(
        { error: depositLog, event_id, id },
        "Failed to persist bridge deposit log",
      )
      return res.status(500).json({ error: "Failed to persist deposit log" })
    }

    if (state === "payment_processed" && receipt?.destination_tx_hash) {
      reconcileByTxHash({ txHash: receipt.destination_tx_hash }).catch((err) =>
        baseLogger.error({ err, event_id, id }, "Real-time reconciliation failed"),
      )
    }

    const auditResult = await writeBridgeDepositRequest({
      eventId: event_id,
      eventObject: event_object,
      rawPayload: req.body,
    })
    if (auditResult instanceof Error) {
      baseLogger.error(
        { error: auditResult, event_id, id },
        "Failed to persist Bridge deposit ERPNext audit row",
      )
      return res.status(500).json({ error: "Failed to persist ERPNext audit row" })
    }

    // Idempotency: mark processed only after local and ERPNext writes succeed, so
    // provider retries can recover audit gaps after transient ERPNext failures.
    const auditLockKey = `bridge-deposit:${event_id}`
    const auditLockResult = await LockService().lockIdempotencyKey(auditLockKey as IdempotencyKey)
    if (auditLockResult instanceof Error) {
      baseLogger.info({ event_id, id, state }, "Duplicate Bridge deposit webhook")
      return res.status(200).json({ status: "already_processed" })
    }

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, id, event_id }, "Error processing Bridge deposit webhook")
    return res.status(500).json({ error: "Internal server error" })
  }
}
