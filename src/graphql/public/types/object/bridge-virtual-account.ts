import { GT } from "@graphql/index"

const BridgeVirtualAccount = GT.Object({
  name: "BridgeVirtualAccount",
  fields: () => ({
    id: { type: GT.ID, resolve: (src) => src.virtualAccountId ?? src.bridgeVirtualAccountId },
    bankName: { type: GT.String },
    routingNumber: { type: GT.String },
    accountNumber: { type: GT.String },
    accountNumberLast4: { type: GT.String },
    pending: { type: GT.Boolean },
    message: { type: GT.String },
    kycLink: { type: GT.String },
    tosLink: { type: GT.String },
  }),
})

export default BridgeVirtualAccount
