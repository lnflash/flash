import type { InternalTransferOrigin } from "@domain/payment-splits"

import { parseRepositoryError } from "./utils"
import { InternalTransferInvoice } from "./schema"

const isDuplicateKeyError = (error: unknown): boolean =>
  (error as { code?: number } | null)?.code === 11000

// Typed RepositoryErrors, so every failure maps cleanly through error-map.
const toError = (error: unknown): RepositoryError => parseRepositoryError(error)

type InternalTransferInvoiceFields = {
  paymentHash: string
  senderWalletId?: string
  recipientWalletId?: string
  origin: InternalTransferOrigin
}

/**
 * Writes this sender's marker for the hash and says whether this call created
 * it (`created: false` when the same hash, sender and origin was already
 * marked). Markers are one row per (hash, sender, origin): another wallet
 * paying the same hash gets its own row. A caller that may later withdraw its
 * marker (deleteInternalTransferInvoice) must only do so when it created it.
 */
export const insertInternalTransferInvoice = async ({
  paymentHash,
  senderWalletId,
  recipientWalletId,
  origin,
}: InternalTransferInvoiceFields): Promise<{ created: boolean } | RepositoryError> => {
  try {
    await InternalTransferInvoice.create({
      paymentHash: paymentHash.toLowerCase(),
      senderWalletId,
      recipientWalletId,
      origin,
      createdAt: new Date(),
    })
    return { created: true }
  } catch (error) {
    if (isDuplicateKeyError(error)) return { created: false }
    return toError(error)
  }
}

/**
 * Marks a payment hash as an invoice Flash minted for one of its own transfers
 * (ENG-653), so a receive on it never triggers the recipient's payment splits.
 * Recording the same hash, sender and origin twice is a no-op.
 */
export const recordInternalTransferInvoice = async (
  fields: InternalTransferInvoiceFields,
): Promise<true | RepositoryError> => {
  const inserted = await insertInternalTransferInvoice(fields)
  return inserted instanceof Error ? inserted : true
}

/**
 * Withdraws a marker this process wrote for a payment that was then rejected
 * outright. Matches on origin and sender as well as the hash, so it only ever
 * removes the caller's own row: another wallet's marker for the same hash
 * stays, and the hash stays internal. Returns whether a row was removed.
 */
export const deleteInternalTransferInvoice = async ({
  paymentHash,
  senderWalletId,
  origin,
}: {
  paymentHash: string
  senderWalletId: string
  origin: InternalTransferOrigin
}): Promise<boolean | RepositoryError> => {
  try {
    const result = await InternalTransferInvoice.deleteOne({
      paymentHash: { $eq: paymentHash.toLowerCase() },
      senderWalletId: { $eq: senderWalletId },
      origin: { $eq: origin },
    })
    return result.deletedCount > 0
  } catch (error) {
    return toError(error)
  }
}

/**
 * True while ANY marker exists for the hash, whoever wrote it and whatever its
 * origin: one Flash payer is enough to make the receive Flash-to-Flash.
 */
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
