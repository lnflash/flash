import { GT } from "@graphql/index"

const BridgeExternalAccount = GT.Object({
  name: "BridgeExternalAccount",
  fields: () => ({
    id: { type: GT.NonNullID },
    bankName: { type: GT.NonNull(GT.String) },
    accountNumberLast4: { type: GT.NonNull(GT.String) },
    status: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeExternalAccount
