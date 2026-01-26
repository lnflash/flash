import { GT } from "@graphql/index"

const BridgeWithdrawal = GT.Object({
  name: "BridgeWithdrawal",
  fields: () => ({
    id: { type: GT.NonNullID },
    amount: { type: GT.NonNull(GT.String) },
    currency: { type: GT.NonNull(GT.String) },
    status: { type: GT.NonNull(GT.String) },
    createdAt: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeWithdrawal
