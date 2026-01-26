import { GT } from "@graphql/index"

const BridgeVirtualAccount = GT.Object({
  name: "BridgeVirtualAccount",
  fields: () => ({
    id: { type: GT.NonNullID },
    bankName: { type: GT.NonNull(GT.String) },
    routingNumber: { type: GT.NonNull(GT.String) },
    accountNumberLast4: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeVirtualAccount
