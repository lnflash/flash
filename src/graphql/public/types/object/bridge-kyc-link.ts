import { GT } from "@graphql/index"

const BridgeKycLink = GT.Object({
  name: "BridgeKycLink",
  fields: () => ({
    kycLink: { type: GT.NonNull(GT.String) },
    tosLink: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeKycLink
