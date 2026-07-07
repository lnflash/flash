/**
 * Bridge KYC Webhook Handler
 * Handles customer status and kyc.* events from Bridge.xyz
 *
 * Bridge sends events to this endpoint for:
 *   customer.created              → uses event_object.id / event_object.status
 *   customer.updated.*            → uses event_object.id / event_object.status
 *   external_account.created      → uses event_object.customer_id
 *   (future kyc.* events handled similarly)
 *
 * Bridge status → internal bridgeKycStatus mapping:
 *   not_started                                          → "not_started"
 *   active (approved)                                    → "approved"
 *   incomplete | awaiting_questionnaire | awaiting_ubo
 *     | under_review | paused                            → "pending"
 *   rejected                                             → "rejected"
 *   offboarded                                           → "offboarded"
 */

import { Request, Response } from "express"
import {
  isBridgeKycInitiated,
  sendBridgeKycNotificationBestEffort,
  toBridgeKycNotificationOutcome,
} from "@app/bridge/send-kyc-notification"
import { AccountsRepository } from "@services/mongoose/accounts"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { toBridgeCustomerId } from "@domain/primitives/bridge"
import BridgeService from "@services/bridge"

const notifyKycStatusChange = async ({
  account,
  previousStatus,
  nextStatus,
  rejectionReasons,
}: {
  account: Account
  previousStatus: Account["bridgeKycStatus"]
  nextStatus: NonNullable<Account["bridgeKycStatus"]>
  rejectionReasons: unknown[]
}) => {
  if (previousStatus === nextStatus) return
  if (!isBridgeKycInitiated(previousStatus)) return

  const outcome = toBridgeKycNotificationOutcome(nextStatus)
  if (!outcome) return

  await sendBridgeKycNotificationBestEffort({
    accountId: account.id,
    outcome,
    kycStatus: nextStatus,
    rejectionReasons,
  })
}

export const kycHandler = async (req: Request, res: Response) => {
  const { event_id, event_object, event_type } = req.body

  // Bridge uses different field names depending on event type:
  // - customer.* events: event_object.id, event_object.status
  // - external_account.* events: event_object.customer_id
  // - (future kyc.* events: event_object.customer_id, event_object.kyc_status)
  const customerId = event_object.customer_id || event_object.id
  const status = event_object.kyc_status || event_object.status
  const rejectionReasons = event_object.rejection_reasons || []

  if (!customerId || !event_id) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  try {
    // Idempotency FIRST: Bridge retries reuse the same event_id, and the lock
    // used to be taken only AFTER all side effects ran (pure bookkeeping —
    // it prevented nothing). Locked means a delivery of this exact event is
    // already being (or was) processed.
    const lockKey = `bridge-kyc:${event_id}`
    const lockResult = await LockService().lockIdempotencyKey(lockKey as IdempotencyKey)
    if (lockResult instanceof Error) {
      baseLogger.info({ customerId, event_id }, "Duplicate Bridge KYC webhook")
      return res.status(200).json({ status: "already_processed" })
    }

    const bridgeCustomerId = toBridgeCustomerId(customerId)
    const account = await AccountsRepository().findByBridgeCustomerId(bridgeCustomerId)
    if (account instanceof Error) {
      baseLogger.warn(
        { customerId, event_type, event_id },
        "Account not found for Bridge customer — may be a timing issue, Bridge will retry",
      )
      return res.status(503).json({ error: "Account not ready" })
    }

    const PENDING_BRIDGE_STATUSES = new Set([
      "incomplete",
      "awaiting_questionnaire",
      "awaiting_ubo",
      "under_review",
      "paused",
    ])

    // Map Bridge customer status fields to our internal kyc status.
    // Bridge customer.status values: not_started, active (approved), rejected,
    // offboarded, plus the pending set above.
    let nextStatus: NonNullable<Account["bridgeKycStatus"]> | undefined
    if (status === "not_started") {
      nextStatus = "not_started"
    } else if (PENDING_BRIDGE_STATUSES.has(status)) {
      nextStatus = status as NonNullable<Account["bridgeKycStatus"]>
    } else if (status === "active" || status === "approved") {
      nextStatus = "approved"
    } else if (status === "rejected") {
      nextStatus = "rejected"
    } else if (status === "offboarded") {
      nextStatus = "offboarded"
    }

    if (!nextStatus) {
      baseLogger.info(
        { accountId: account.id, customerId, status, event_type },
        "Unhandled Bridge customer status — no action taken",
      )
      return res.status(200).json({ status: "success" })
    }

    // Atomic compare-and-swap: only the delivery that actually changes the
    // status wins. Losers (distinct events carrying the same status, e.g.
    // customer.created racing customer.updated — the double-push bug) skip
    // notifications and side effects entirely.
    const transition = await AccountsRepository().transitionBridgeKycStatus(
      account.id,
      nextStatus,
    )
    if (transition instanceof Error) {
      baseLogger.error(
        { accountId: account.id, error: transition },
        "Failed to update KYC status",
      )
      return res.status(500).json({ error: "Failed to update status" })
    }
    if (!transition.changed) {
      baseLogger.info(
        { accountId: account.id, customerId, status, event_type },
        "Bridge KYC status already current — skipping notification/side effects",
      )
      return res.status(200).json({ status: "already_current" })
    }

    if (nextStatus !== "not_started") {
      await notifyKycStatusChange({
        account,
        previousStatus: transition.previousStatus,
        nextStatus,
        rejectionReasons,
      })
    }

    if (nextStatus === "approved") {
      baseLogger.info({ accountId: account.id, customerId }, "Bridge KYC approved")
      const vaResult = await BridgeService.createVirtualAccount(account.id)
      if (vaResult instanceof Error) {
        baseLogger.error(
          { accountId: account.id, error: vaResult },
          "Failed to auto-create virtual account after KYC approval",
        )
      } else {
        baseLogger.info(
          { accountId: account.id, virtualAccountId: vaResult.virtualAccountId },
          "Virtual account auto-created after KYC approval",
        )
      }
    } else if (nextStatus === "rejected") {
      baseLogger.warn(
        { accountId: account.id, customerId, rejectionReasons },
        "Bridge KYC rejected",
      )
    } else if (nextStatus === "offboarded") {
      baseLogger.warn({ accountId: account.id, customerId }, "Bridge KYC offboarded")
    } else {
      baseLogger.info(
        { accountId: account.id, customerId, status: nextStatus },
        "Bridge KYC status updated",
      )
    }

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, customerId }, "Error processing Bridge KYC webhook")
    return res.status(500).json({ error: "Internal server error" })
  }
}
