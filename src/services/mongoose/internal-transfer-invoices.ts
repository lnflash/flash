import type { InternalTransferOrigin } from "@domain/payment-splits"

import { parseRepositoryError } from "./utils"
import { InternalTransferInvoice } from "./schema"

const isDuplicateKeyError = (error: unknown): boolean =>
  (error as { code?: number } | null)?.code === 11000

// Typed RepositoryErrors, so every failure maps cleanly through error-map.
const toError = (error: unknown): RepositoryError => parseRepositoryError(error)

/**
 * Marks a payment hash as an invoice Flash minted for one of its own transfers
 * (ENG-653), so a receive on it never triggers the recipient's payment splits.
 * Recording the same hash twice is a no-op.
 */
export const recordInternalTransferInvoice = async ({
  paymentHash,
  senderWalletId,
  recipientWalletId,
  origin,
}: {
  paymentHash: string
  senderWalletId?: string
  recipientWalletId?: string
  origin: InternalTransferOrigin
}): Promise<true | RepositoryError> => {
  try {
    await InternalTransferInvoice.create({
      paymentHash: paymentHash.toLowerCase(),
      senderWalletId,
      recipientWalletId,
      origin,
      createdAt: new Date(),
    })
    return true
  } catch (error) {
    if (isDuplicateKeyError(error)) return true
    return toError(error)
  }
}

export const isInternalTransferInvoice = async (
  paymentHash: string,
): Promise<boolean | RepositoryError> => {
  try {
    const found = await InternalTransferInvoice.exists({
      paymentHash: { $eq: paymentHash.toLowerCase() },
    })
    return found !== null
  } catch (error) {
    return toError(error)
  }
}
