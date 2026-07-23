import { GT } from "@graphql/index"

const BridgeExternalAccountLink = GT.Object({
  name: "BridgeExternalAccountLink",
  fields: () => ({
    linkToken: { type: GT.NonNull(GT.String) },
    linkUrl: {
      type: GT.String,
      deprecationReason:
        "Use linkToken with the Plaid Link SDK. Hosted-URL linking is being retired; this field is best-effort and may be null.",
    },
    expiresAt: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeExternalAccountLink
