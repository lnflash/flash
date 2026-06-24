/**
 * Bridge Deposit Webhook Handler
 * Handles incoming-funds events from Bridge.xyz via the /deposit route.
 *
 * Two event categories land here:
 *   - virtual_account.activity  — fiat payments hitting a virtual account
 *   - bridge_wallet.activity    — on-chain/off-chain bridge wallet movements
 *
 * Both represent money arriving that needs to be logged for reconciliation.
 * The actual balance crediting happens when IBEX sends its crypto.received webhook.
 */

import { Request, Response } from "express"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { createBridgeDeposit } from "@services/mongoose/bridge-deposit-log"
import { reconcileByTxHash } from "@services/bridge/reconciliation"
import { writeBridgeDepositRequest } from "@services/frappe/BridgeTransferRequestWriter"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { alertIbexReconciliationFailed } from "@services/alerts/ibex-bridge-movement"

type DepositEventObject = {
  id: string
  amount: string
  currency?: string
  // Transfer event shape
  state?: string
  on_behalf_of?: string
  developer_fee?: string
  receipt?: {
    initial_amount?: string
    subtotal_amount?: string
    final_amount?: string
    developer_fee?: string
    destination_tx_hash?: string
  }
  // Virtual account activity shape
  type?: string
  customer_id?: string
  virtual_account_id?: string
  deposit_id?: string
  subtotal_amount?: string
  developer_fee_amount?: string
  exchange_fee_amount?: string
  destination_payment_rail?: string
  // Bridge wallet activity shape
  bridge_wallet_id?: string
  available_balance?: string
  destination?: {
    tx_hash?: string
  }
  payment_route?: {
    type?: string
    customer_id?: string
    transfer_id?: string
    deposit_id?: string
    virtual_account_id?: string
  }
}

export const depositHandler = async (req: Request, res: Response) => {
  const { event_id, event_category, event_object } = req.body
  const obj = (event_object ?? {}) as DepositEventObject

  // Normalise from either payload shape.
  // Transfer events use on_behalf_of; virtual_account / bridge_wallet use customer_id.
  const customerId = obj.on_behalf_of ?? obj.customer_id ?? obj.payment_route?.customer_id
  // "state" for transfers, "type" (funds_received / deposit / etc.) for others
  const state = obj.state ?? obj.type
  const currency = obj.currency ?? "usd"

  if (!obj.id || !event_id) {
    baseLogger.warn(
      { event_id, event_category, event_object_id: obj.id },
      "Bridge deposit webhook rejected: missing required fields",
    )
    return res.status(400).json({
      error: "Invalid payload",
      detail: "Missing one or more required fields: id, event_id",
    })
  }

  if (!obj.amount || !customerId) {
    baseLogger.warn(
      {
        event_id,
        event_category,
        event_object_id: obj.id,
        has_amount: Boolean(obj.amount),
        has_customer_identifier: Boolean(customerId),
      },
      "Bridge deposit webhook acknowledged without deposit row: missing crediting fields",
    )
    return res.status(200).json({
      status: "skipped",
      reason: "missing_crediting_fields",
    })
  }

  try {
    const rxReceipt = obj.receipt

    const developerFee =
      asOptionalString(rxReceipt?.developer_fee) ??
      asOptionalString(obj.developer_fee_amount) ??
      asOptionalString(obj.developer_fee) ??
      "0.0"

    baseLogger.info(
      {
        event_id,
        event_category,
        id: obj.id,
        state,
        amount: obj.amount,
        currency,
        customerId,
        developerFee,
        subtotalAmount: rxReceipt?.subtotal_amount ?? obj.subtotal_amount,
        destinationTxHash: rxReceipt?.destination_tx_hash ?? obj.destination?.tx_hash,
      },
      "Bridge deposit event",
    )

    const depositLog = await createBridgeDeposit({
      eventId: event_id,
      transferId: obj.id,
      customerId,
      state: state ?? "unknown",
      amount: String(obj.amount),
      currency,
      developerFee,
      subtotalAmount:
        asOptionalString(rxReceipt?.subtotal_amount) ??
        asOptionalString(obj.subtotal_amount),
      initialAmount: asOptionalString(rxReceipt?.initial_amount),
      finalAmount: asOptionalString(rxReceipt?.final_amount),
      destinationTxHash: rxReceipt?.destination_tx_hash ?? obj.destination?.tx_hash,
    })

    if (depositLog instanceof Error) {
      baseLogger.error(
        { error: depositLog, event_id, id: obj.id },
        "Failed to persist bridge deposit log",
      )
      return res.status(500).json({ error: "Failed to persist deposit log" })
    }

    // Real-time reconciliation: only trigger for transfer events that have
    // reached payment_processed with an on-chain tx hash.
    if (
      event_category === "transfer" &&
      state === "payment_processed" &&
      rxReceipt?.destination_tx_hash
    ) {
      const txHash = rxReceipt.destination_tx_hash
      reconcileByTxHash({ txHash }).catch((err) => {
        baseLogger.error({ err, event_id, id: obj.id }, "Real-time reconciliation failed")
        alertIbexReconciliationFailed({
          txHash,
          detail: err instanceof Error ? err.message : String(err),
        })
      })
    }

    const auditResult = await writeBridgeDepositRequest({
      eventId: event_id,
      eventObject: event_object,
      rawPayload: req.body,
    })
    if (auditResult instanceof Error) {
      baseLogger.error(
        { error: auditResult, event_id, id: obj.id },
        "Failed to persist Bridge deposit ERPNext audit row",
      )
      alertBridge({
        dedupKey: generateDedupKey.erpnextDepositAudit(obj.id),
        source: "erpnext-audit",
        severity: "critical",
        title: "Bridge deposit ERPNext audit write failed",
        detail: auditResult.message,
        context: { event_id, transfer_id: obj.id },
      })
      return res.status(500).json({ error: "Failed to persist ERPNext audit row" })
    }

    // Mark processed only after local and ERPNext writes succeed, so provider
    // retries can recover audit gaps after transient persistence failures.
    const auditLockKey = `bridge-deposit:${event_id}`
    const auditLockResult = await LockService().lockIdempotencyKey(
      auditLockKey as IdempotencyKey,
    )
    if (auditLockResult instanceof Error) {
      baseLogger.info({ event_id, id: obj.id, state }, "Duplicate Bridge deposit webhook")
      return res.status(200).json({ status: "already_processed" })
    }

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error(
      { error, id: obj.id, event_id },
      "Error processing Bridge deposit webhook",
    )
    alertBridge({
      dedupKey: generateDedupKey.bridgeWebhookDeposit(event_id),
      source: "bridge-webhook",
      severity: "critical",
      title: "Bridge deposit webhook processing error",
      detail: error instanceof Error ? error.message : String(error),
      context: { event_id, transfer_id: obj.id },
    })
    return res.status(500).json({ error: "Internal server error" })
  }
}

const asOptionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return String(value)
}
