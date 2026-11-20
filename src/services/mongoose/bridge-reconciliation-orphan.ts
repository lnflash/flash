import { BridgeReconciliationOrphan } from "./schema"

type OrphanType =
  | "bridge_without_ibex"
  | "ibex_without_bridge"
  | "bridge_transfer_without_ibex_send"
  | "ibex_send_without_bridge_settlement"
type OrphanStatus = "unmatched" | "resolved"

export const upsertBridgeReconciliationOrphan = async (data: {
  orphanKey: string
  orphanType: OrphanType
  transferId?: string
  txHash?: string
  bridgeEventId?: string
  customerId?: string
  amount?: string
  currency?: string
  triageContext: Record<string, unknown>
}): Promise<{ id: string; created: boolean } | Error> => {
  try {
    // One atomic upsert. `created` lets an hourly caller alert once per
    // orphan, not every run, and detectedAt is set only on insert so an orphan
    // still open days later keeps the time it was first seen.
    const res = await BridgeReconciliationOrphan.findOneAndUpdate(
      { orphanKey: data.orphanKey },
      {
        $set: { ...data, status: "unmatched" },
        $setOnInsert: { detectedAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true },
    )
    if (!res.value)
      return new Error(`orphan upsert returned no document: ${data.orphanKey}`)

    return {
      id: res.value._id.toString(),
      created: !res.lastErrorObject?.updatedExisting,
    }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export const resolveOrphansByTxHash = async (
  txHash: string,
): Promise<{ resolvedCount: number } | Error> => {
  try {
    const now = new Date()
    const result = await BridgeReconciliationOrphan.updateMany(
      {
        txHash: txHash.toLowerCase(),
        status: "unmatched",
      },
      { $set: { status: "resolved", resolvedAt: now } },
    )
    return { resolvedCount: result.modifiedCount }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

// Resolves the open orphans with these keys. A withdrawal's orphans are keyed
// by transfer id, not tx hash, and an orphan Bridge or a later run settled
// (a stuck withdrawal Bridge paid out, a transfer a later run deleted) must
// leave the unmatched list (ENG-891).
export const resolveOrphansByKey = async (
  keys: string[],
): Promise<{ resolvedCount: number } | Error> => {
  if (keys.length === 0) return { resolvedCount: 0 }
  try {
    const result = await BridgeReconciliationOrphan.updateMany(
      { orphanKey: { $in: keys }, status: "unmatched" },
      { $set: { status: "resolved", resolvedAt: new Date() } },
    )
    return { resolvedCount: result.modifiedCount }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export const findOrphans = async ({
  status,
  orphanType,
  limit = 50,
}: {
  status?: OrphanStatus
  orphanType?: OrphanType
  limit?: number
} = {}): Promise<
  | {
      id: string
      orphanKey: string
      orphanType: OrphanType
      status: OrphanStatus
      transferId?: string
      txHash?: string
      customerId?: string
      amount?: string
      currency?: string
      triageContext: Record<string, unknown>
      detectedAt: Date
      resolvedAt?: Date
    }[]
  | Error
> => {
  try {
    const filter: Record<string, unknown> = {}
    if (status) filter.status = status
    if (orphanType) filter.orphanType = orphanType

    const docs = await BridgeReconciliationOrphan.find(filter)
      .sort({ detectedAt: -1 })
      .limit(limit)
      .lean()
      .exec()

    return docs.map((d) => ({
      id: (d._id as { toString(): string }).toString(),
      orphanKey: d.orphanKey as string,
      orphanType: d.orphanType as OrphanType,
      status: (d.status ?? "unmatched") as OrphanStatus,
      transferId: d.transferId as string | undefined,
      txHash: d.txHash as string | undefined,
      customerId: d.customerId as string | undefined,
      amount: d.amount as string | undefined,
      currency: d.currency as string | undefined,
      triageContext: d.triageContext as Record<string, unknown>,
      detectedAt: d.detectedAt as Date,
      resolvedAt: d.resolvedAt as Date | undefined,
    }))
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
