import { GT } from "@graphql/index"

const BridgeWithdrawal = GT.Object({
  name: "BridgeWithdrawal",
  fields: () => ({
    transferId: { type: GT.NonNullID },
    amount: { type: GT.NonNull(GT.String) },
    currency: { type: GT.NonNull(GT.String) },
    state: { type: GT.NonNull(GT.String) },
    failureReason: { type: GT.String },
    createdAt: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeWithdrawal
