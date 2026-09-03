import { toBridgeCustomerId } from "@domain/primitives/bridge"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import BridgeApiClient from "./client"

// The slice of a Bridge customer we keep on an ID Verification record when
// Bridge KYC is the identity source: id, status, updated_at, endorsements —
// nothing else (no name, email, address).
export type BridgeCustomerSnapshot = {
  id: string
  status?: string
  updated_at?: string
  endorsements?: unknown[]
}

// Never throws: a snapshot is a nice-to-have on the request, not a gate.
export const snapshotBridgeCustomer = async ({
  bridgeCustomerId,
}: {
  bridgeCustomerId: string
}): Promise<BridgeCustomerSnapshot | undefined> => {
  try {
    const customer = await BridgeApiClient.getCustomer(
      toBridgeCustomerId(bridgeCustomerId),
    )
    return {
      id: customer.id,
      status: customer.status,
      updated_at: customer.updated_at,
      endorsements: customer.endorsements,
    }
  } catch (error) {
    baseLogger.warn(
      { error, bridgeCustomerId },
      "Could not snapshot Bridge customer for ID verification; continuing without it",
    )
    recordExceptionInCurrentSpan({ error })
    return undefined
  }
}
