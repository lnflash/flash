import { GT } from "@graphql/index"

const BridgeExternalAccountLink = GT.Object({
  name: "BridgeExternalAccountLink",
  fields: () => ({
    linkToken: { type: GT.NonNull(GT.String) },
    expiresAt: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeExternalAccountLink
