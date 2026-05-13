/**
 * Bridge KYC Webhook Handler
 * Handles kyc.approved and kyc.rejected events from Bridge.xyz
 */

import { Request, Response } from "express"
import { AccountsRepository } from "@services/mongoose/accounts"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { toBridgeCustomerId } from "@domain/primitives/bridge"
import BridgeService from "@services/bridge"

export const kycHandler = async (req: Request, res: Response) => {

  const { event_id, event_object } = req.body
  const { customer_id, kyc_status, rejection_reasons } = event_object

  if (!customer_id || !event_id) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  // Idempotency check using customer_id + event as lock key
  const lockKey = `bridge-kyc:${customer_id}:${event_object.kyc_status}:${event_object.id}`
  const lockResult = await LockService().lockIdempotencyKey(lockKey as any)
  if (lockResult instanceof Error) {
    baseLogger.info({ customer_id, event_id }, "Duplicate Bridge KYC webhook")
    return res.status(200).json({ status: "already_processed" })
  }

  try {
    const bridgeCustomerId = toBridgeCustomerId(customer_id)
    const account = await AccountsRepository().findByBridgeCustomerId(bridgeCustomerId)
    if (account instanceof Error) {
      baseLogger.warn({ customer_id }, "Account not found for Bridge customer — may be a timing issue, Bridge will retry")
      return res.status(503).json({ error: "Account not ready" })
    }

    // Update KYC status based on event
    if (kyc_status === "approved") {
      const result = await AccountsRepository().updateBridgeFields(account.id, {
        bridgeKycStatus: "approved",
      })

      if (result instanceof Error) {
        baseLogger.error(
          { accountId: account.id, error: result },
          "Failed to update KYC status",
        )
        return res.status(500).json({ error: "Failed to update status" })
      }

      baseLogger.info({ accountId: account.id, customer_id }, "Bridge KYC approved")

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
    } else if (kyc_status === "rejected") {
      const result = await AccountsRepository().updateBridgeFields(account.id, {
        bridgeKycStatus: "rejected",
      })

      if (result instanceof Error) {
        baseLogger.error(
          { accountId: account.id, error: result },
          "Failed to update KYC status",
        )
        return res.status(500).json({ error: "Failed to update status" })
      }

      baseLogger.warn(
        {
          accountId: account.id,
          customer_id,
          rejection_reasons,
        },
        "Bridge KYC rejected",
      )
    }

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, customer_id }, "Error processing Bridge KYC webhook")
    return res.status(500).json({ error: "Internal server error" })
  }
}
