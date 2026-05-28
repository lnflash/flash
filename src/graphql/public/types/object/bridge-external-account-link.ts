import { GT } from "@graphql/index"

const BridgeExternalAccountLink = GT.Object({
  name: "BridgeExternalAccountLink",
  fields: () => ({
    linkUrl: { type: GT.NonNull(GT.String) },
    expiresAt: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeExternalAccountLink
