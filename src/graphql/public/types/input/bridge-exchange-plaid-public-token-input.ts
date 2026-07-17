import { GT } from "@graphql/index"

const BridgeExchangePlaidPublicTokenInput = GT.Input({
  name: "BridgeExchangePlaidPublicTokenInput",
  fields: () => ({
    linkToken: { type: GT.NonNull(GT.String) },
    publicToken: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeExchangePlaidPublicTokenInput
