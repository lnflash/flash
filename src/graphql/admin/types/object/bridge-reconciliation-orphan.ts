import { GT } from "@graphql/index"

const BridgeReconciliationOrphanObject = GT.Object({
  name: "BridgeReconciliationOrphan",
  fields: () => ({
    id: { type: GT.NonNullID },
    orphanKey: { type: GT.NonNull(GT.String) },
    orphanType: { type: GT.NonNull(GT.String) },
    status: { type: GT.NonNull(GT.String) },
    txHash: { type: GT.String },
    transferId: { type: GT.String },
    customerId: { type: GT.String },
    amount: { type: GT.String },
    currency: { type: GT.String },
    detectedAt: { type: GT.NonNull(GT.String) },
    resolvedAt: { type: GT.String },
    triageContext: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeReconciliationOrphanObject
