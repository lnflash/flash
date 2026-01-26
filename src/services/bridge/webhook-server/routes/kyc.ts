/**
 * Bridge KYC Webhook Handler
 * Handles kyc.approved and kyc.rejected events from Bridge.xyz
 */

import { Request, Response } from "express"
import { AccountsRepository } from "@services/mongoose/accounts"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { toBridgeCustomerId } from "@domain/primitives/bridge"

export const kycHandler = async (req: Request, res: Response) => {
  const { event, data } = req.body
  const { customer_id, kyc_status, reason } = data

  if (!customer_id || !event) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  // Idempotency check using customer_id + event as lock key
  const lockKey = `bridge-kyc:${customer_id}:${event}`
  const lockResult = await LockService().lockIdempotencyKey(lockKey as any)
  if (lockResult instanceof Error) {
    baseLogger.info({ customer_id, event }, "Duplicate Bridge KYC webhook")
    return res.status(200).json({ status: "already_processed" })
  }

  try {
    const bridgeCustomerId = toBridgeCustomerId(customer_id)
    const account = await AccountsRepository().findByBridgeCustomerId(bridgeCustomerId)

    if (account instanceof Error) {
      baseLogger.error({ customer_id }, "Account not found for Bridge customer")
      return res.status(404).json({ error: "Account not found" })
    }

    // Update KYC status based on event
    if (event === "kyc.approved") {
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
    } else if (event === "kyc.rejected") {
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
          reason,
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
