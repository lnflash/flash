/**
 * Bridge External Account Webhook Handler
 * Handles external_account.created and external_account.updated events from Bridge.xyz
 *
 * Fires after a user completes the Plaid bank-linking flow.
 * Persists the linked account to MongoDB so it appears in bridgeExternalAccounts queries.
 *
 * Status mapping:
 *   active: true  → "verified"
 *   active: false → "failed"
 */

import { Request, Response } from "express"
import { AccountsRepository } from "@services/mongoose/accounts"
import { LockService } from "@services/lock"
import { baseLogger } from "@services/logger"
import { toBridgeCustomerId } from "@domain/primitives/bridge"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"

const toStatus = (active: boolean | undefined): "pending" | "verified" | "failed" => {
  if (active === true) return "verified"
  if (active === false) return "failed"
  return "pending"
}

export const externalAccountHandler = async (req: Request, res: Response) => {
  const { event_id, event_object } = req.body
  const { id, customer_id, bank_name, last_4, active } = event_object ?? {}

  if (!id || !customer_id || !event_id) {
    return res.status(400).json({ error: "Invalid payload" })
  }

  try {
    const bridgeCustomerId = toBridgeCustomerId(customer_id)
    const account = await AccountsRepository().findByBridgeCustomerId(bridgeCustomerId)
    if (account instanceof Error) {
      baseLogger.warn(
        { customer_id, event_id },
        "Account not found for Bridge customer — may be a timing issue, Bridge will retry",
      )
      return res.status(503).json({ error: "Account not ready" })
    }

    const lockKey = `bridge-external-account:${event_id}`
    const lockResult = await LockService().lockIdempotencyKey(lockKey as IdempotencyKey)
    if (lockResult instanceof Error) {
      baseLogger.info({ customer_id, event_id, id }, "Duplicate Bridge external account webhook")
      return res.status(200).json({ status: "already_processed" })
    }

    const status = toStatus(active)

    const result = await BridgeAccountsRepo.createExternalAccount({
      accountId: String(account.id),
      bridgeExternalAccountId: id,
      bankName: bank_name ?? "Unknown",
      accountNumberLast4: last_4 ?? "0000",
      status,
    })

    if (result instanceof Error) {
      baseLogger.error(
        { accountId: account.id, event_id, id, error: result },
        "Failed to persist Bridge external account",
      )
      return res.status(500).json({ error: "Failed to persist external account" })
    }

    baseLogger.info(
      { accountId: account.id, bridgeExternalAccountId: id, status },
      "Bridge external account persisted",
    )

    return res.status(200).json({ status: "success" })
  } catch (error) {
    baseLogger.error({ error, customer_id, event_id }, "Error processing Bridge external account webhook")
    return res.status(500).json({ error: "Internal server error" })
  }
}
