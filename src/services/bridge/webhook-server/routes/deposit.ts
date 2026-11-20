/**
 * Bridge Deposit Webhook Handler
 * Handles incoming-funds events from Bridge.xyz via the /deposit route.
 *
 * Two event categories land here:
 *   - virtual_account.activity  — fiat payments hitting a virtual account
 *   - bridge_wallet.activity    — on-chain/off-chain bridge wallet movements
 *
 * Both represent money arriving that needs to be logged for reconciliation.
 * IBEX credits the user's USDT wallet itself; Flash records that credit
 * (recordIbexCryptoReceive) when IBEX Hub reports it, when a virtual-account
 * deposit reaches payment_processed here, or at the hourly matcher, whichever
 * finds the credit first (ENG-891).
 */

import { Request, Response } from "express"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { createBridgeDeposit } from "@services/mongoose/bridge-deposit-log"
import { reconcileByTxHash } from "@services/bridge/reconciliation"
import { writeBridgeDepositRequest } from "@services/frappe/BridgeTransferRequestWriter"
import {
  BRIDGE_DEPOSIT_REFUND_STATES,
  BRIDGE_DEPOSIT_TERMINAL_FAILURE_STATES,
  bridgeDepositFailureReason,
} from "@services/bridge/deposit-states"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { alertIbexReconciliationFailed } from "@services/alerts/ibex-bridge-movement"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { findAccountByBridgeCustomerId } from "@services/bridge/account-lookup"
import { matchBridgeDepositNow } from "@app/bridge/match-ibex-deposits"

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
  // Refund activity (refund_in_flight / refunded / refund_failed)
  refund?: {
    code?: string
    reason?: string
    refunded_at?: string
    refund_reference_id?: string
    risk_rejection_reason?: string
  }
  source?: {
    payment_rail?: string
    originator_name?: string
    sender_name?: string
    bank_name?: string
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
    // A virtual account deactivation is not a deposit and may carry no
    // amount; ops still need to hear about it. Bridge does not retry a 200, so
    // this alerts once per delivery.
    if (state && isVirtualAccountAlert(state)) {
      await alertVirtualAccountEvent({
        eventId: event_id,
        obj,
        state,
        customerId,
        currency,
      })
    }
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
      notifyOpsEvent({
        flow: "deposit",
        phase: "failed",
        status: "failed",
        step: "persist-deposit-log",
        error: depositLog.constructor.name,
        amount: { value: String(obj.amount), currency },
        meta: { customerId, transferId: obj.id },
      })
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
      notifyOpsEvent({
        flow: "deposit",
        phase: "failed",
        status: "failed",
        step: "erpnext-audit",
        error: auditResult.constructor.name,
        amount: { value: String(obj.amount), currency },
        meta: { customerId, transferId: obj.id },
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

    // A virtual-account deposit Bridge has delivered on chain (ENG-891): record
    // its IBEX credit now if IBEX already made it. Not through
    // reconcileByTxHash, which would file a false "no IBEX receive" orphan
    // whenever Bridge's event beats IBEX's credit; recording the credit runs
    // that reconcile itself. Not awaited, so the IBEX reads never hold
    // Bridge's response.
    const destinationTxHash = rxReceipt?.destination_tx_hash ?? obj.destination?.tx_hash
    if (
      event_category === "virtual_account.activity" &&
      state === "payment_processed" &&
      destinationTxHash
    ) {
      matchBridgeDepositNow({ transferId: obj.id, customerId, destinationTxHash })
        .then((result) =>
          baseLogger.info(
            { event_id, id: obj.id, txHash: destinationTxHash, result },
            "Real-time Bridge deposit to IBEX credit match",
          ),
        )
        .catch((error) =>
          baseLogger.error(
            { error, event_id, id: obj.id },
            "Real-time Bridge deposit to IBEX credit match threw",
          ),
        )
    }

    if (
      state &&
      (BRIDGE_DEPOSIT_REFUND_STATES.has(state) ||
        BRIDGE_DEPOSIT_TERMINAL_FAILURE_STATES.has(state))
    ) {
      alertDepositNotDelivered({ eventId: event_id, obj, state, customerId, currency })
    } else if (state && isVirtualAccountAlert(state)) {
      await alertVirtualAccountEvent({
        eventId: event_id,
        obj,
        state,
        customerId,
        currency,
      })
    } else {
      notifyOpsEvent({
        flow: "deposit",
        phase: "succeeded",
        status: "success",
        amount: { value: String(obj.amount), currency },
        meta: { customerId, transferId: obj.id },
      })
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
    notifyOpsEvent({
      flow: "deposit",
      phase: "failed",
      status: "failed",
      step: "exception",
      error: error instanceof Error ? error.constructor.name : String(error),
      meta: { transferId: obj.id },
    })
    return res.status(500).json({ error: "Internal server error" })
  }
}

const asOptionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return String(value)
}

// Bridge is returning, has returned, or could not deliver this deposit. Sent
// once per event (after the idempotency lock), so ops learn that money they
// may have been told is arriving will not reach the customer. A failed refund
// pages: the funds are stuck at Bridge until the sender's bank account is
// reachable. Every other case informs.
const alertDepositNotDelivered = ({
  eventId,
  obj,
  state,
  customerId,
  currency,
}: {
  eventId: string
  obj: DepositEventObject
  state: string
  customerId: string
  currency: string
}) => {
  const depositId = obj.deposit_id ?? obj.payment_route?.deposit_id ?? obj.id
  const reason = bridgeDepositFailureReason({ state, refund: obj.refund })
  const originatorName = obj.source?.originator_name ?? obj.source?.sender_name
  const amountText = `${obj.amount} ${currency.toUpperCase()}`

  alertBridge({
    dedupKey: generateDedupKey.bridgeDepositNotDelivered(depositId, state),
    source: "bridge-webhook",
    severity: state === "refund_failed" ? "critical" : "warning",
    title:
      state === "refund_in_flight"
        ? `Bridge deposit being refunded: ${amountText}`
        : state === "refunded"
          ? `Bridge deposit refunded: ${amountText}`
          : `Bridge deposit not delivered (${state}): ${amountText}`,
    detail: reason,
    context: {
      event_id: eventId,
      state,
      customer_id: customerId,
      deposit_id: depositId,
      amount: obj.amount,
      currency,
      refund_code: obj.refund?.code,
      refund_reason: obj.refund?.reason,
      risk_rejection_reason: obj.refund?.risk_rejection_reason,
      refund_reference_id: obj.refund?.refund_reference_id,
      originator_name: originatorName,
      originator_bank: obj.source?.bank_name,
      payment_rail: obj.source?.payment_rail,
    },
  })

  notifyOpsEvent({
    flow: "deposit",
    phase: state.replace(/_/g, "-"),
    status: state === "refund_in_flight" ? "pending" : "failed",
    step: state,
    error: reason,
    amount: { value: String(obj.amount), currency },
    meta: {
      customerId,
      depositId,
      ...(obj.refund?.code ? { refundCode: String(obj.refund.code) } : {}),
      ...(originatorName ? { originator: originatorName } : {}),
    },
  })
}

// Virtual account events ops are told about (ENG-889), and what each means.
// Neither changes how the deposit row is written.
// https://apidocs.bridge.xyz/platform/orchestration/virtual_accounts/virtual-account-events
const VIRTUAL_ACCOUNT_ALERTS: Readonly<
  Record<string, { title: string; detail: string }>
> = {
  in_review: {
    title: "Bridge deposit under manual review",
    detail:
      "Bridge is reviewing this deposit by hand. It is not delivered until the review ends.",
  },
  deactivation: {
    title: "Bridge virtual account deactivated",
    detail:
      "Bridge deactivated this customer's virtual account. Deposits to it are no longer accepted.",
  },
}

const isVirtualAccountAlert = (state: string): boolean =>
  Object.prototype.hasOwnProperty.call(VIRTUAL_ACCOUNT_ALERTS, state)

type MappedAccount = { accountId?: string; username?: string; lookup: string }

// Display only: a lookup that fails is reported in the alert, never thrown.
const mappedAccount = async (customerId?: string): Promise<MappedAccount> => {
  if (!customerId) return { lookup: "no_customer_id" }
  const lookup = await findAccountByBridgeCustomerId(customerId)
  switch (lookup.kind) {
    case "found":
      return {
        accountId: lookup.account.id,
        username: lookup.account.username,
        lookup: "found",
      }
    case "not_found":
      return { lookup: "not_found" }
    default:
      return { lookup: "failed" }
  }
}

const alertVirtualAccountEvent = async ({
  eventId,
  obj,
  state,
  customerId,
  currency,
}: {
  eventId: string
  obj: DepositEventObject
  state: string
  customerId?: string
  currency: string
}) => {
  const copy = VIRTUAL_ACCOUNT_ALERTS[state]
  const account = await mappedAccount(customerId)
  const depositId = obj.deposit_id ?? obj.payment_route?.deposit_id
  const virtualAccountId = obj.virtual_account_id ?? obj.payment_route?.virtual_account_id
  // Deactivation events carry "0.0" or no amount: only show a real one.
  const amount = obj.amount && Number(obj.amount) !== 0 ? String(obj.amount) : undefined
  const who = account.username ?? customerId ?? "unknown customer"

  alertBridge({
    dedupKey: generateDedupKey.bridgeVirtualAccountEvent(eventId, state),
    source: "bridge-webhook",
    severity: "warning",
    title: `${copy.title}: ${amount ? `${amount} ${currency.toUpperCase()}, ` : ""}${who}`,
    detail: copy.detail,
    context: {
      event_id: eventId,
      type: state,
      customer_id: customerId,
      account_id: account.accountId,
      username: account.username,
      account_lookup: account.lookup,
      virtual_account_id: virtualAccountId,
      deposit_id: depositId,
      amount,
      currency: amount ? currency : undefined,
      payment_rail: obj.source?.payment_rail,
    },
  })

  notifyOpsEvent({
    flow: "deposit",
    phase: state.replace(/_/g, "-"),
    status: state === "deactivation" ? "failed" : "pending",
    accountId: account.accountId,
    step: state,
    ...(amount ? { amount: { value: amount, currency } } : {}),
    meta: {
      ...(customerId ? { customerId } : {}),
      ...(depositId ? { depositId } : {}),
      ...(virtualAccountId ? { virtualAccountId } : {}),
    },
  })
}
