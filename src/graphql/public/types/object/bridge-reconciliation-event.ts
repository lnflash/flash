import { GT } from "@graphql/index"

const BridgeReconciliationEvent = GT.Object({
  name: "BridgeReconciliationEvent",
  fields: () => ({
    txHash: { type: GT.NonNull(GT.String) },
    status: { type: GT.NonNull(GT.String) },
    orphanType: { type: GT.String },
    transferId: { type: GT.String },
    customerId: { type: GT.String },
    amount: { type: GT.String },
    currency: { type: GT.String },
    detectedAt: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeReconciliationEvent
