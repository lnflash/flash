import { GT } from "@graphql/index"
import BridgeReconciliationOrphanObject from "@graphql/admin/types/object/bridge-reconciliation-orphan"
import { findOrphans } from "@services/mongoose/bridge-reconciliation-orphan"

const BridgeReconciliationOrphansQuery = GT.Field({
  type: GT.NonNullList(BridgeReconciliationOrphanObject),
  args: {
    status: { type: GT.String, defaultValue: null },
    orphanType: { type: GT.String, defaultValue: null },
    limit: { type: GT.Int, defaultValue: 50 },
  },
  resolve: async (_: unknown, { status, orphanType, limit }: { status?: string; orphanType?: string; limit?: number }) => {
    const result = await findOrphans({
      status: status as "unmatched" | "resolved" | undefined,
      orphanType: orphanType as "bridge_without_ibex" | "ibex_without_bridge" | undefined,
      limit: limit ?? 50,
    })

    if (result instanceof Error) throw result

    return result.map((o) => ({
      ...o,
      detectedAt: o.detectedAt.toISOString(),
      resolvedAt: o.resolvedAt?.toISOString() ?? null,
      triageContext: JSON.stringify(o.triageContext),
    }))
  },
})

export default BridgeReconciliationOrphansQuery
