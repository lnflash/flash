import { BridgeReconciliationOrphan } from "./schema"

type OrphanType = "bridge_without_ibex" | "ibex_without_bridge"

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
}): Promise<{ id: string } | Error> => {
  try {
    const orphan = await BridgeReconciliationOrphan.findOneAndUpdate(
      { orphanKey: data.orphanKey },
      { ...data, detectedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )

    return { id: orphan._id.toString() }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
