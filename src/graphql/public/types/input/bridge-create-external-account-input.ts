import { GT } from "@graphql/index"

const BridgeCreateExternalAccountInput = GT.Input({
  name: "BridgeCreateExternalAccountInput",
  fields: () => ({
    bankName: { type: GT.NonNull(GT.String) },
    accountNumber: { type: GT.NonNull(GT.String) },
    routingNumber: { type: GT.NonNull(GT.String) },
    accountOwnerName: { type: GT.NonNull(GT.String) },
    checkingOrSavings: { type: GT.String, defaultValue: "checking" },
    streetLine1: { type: GT.NonNull(GT.String) },
    city: { type: GT.NonNull(GT.String) },
    state: { type: GT.NonNull(GT.String) },
    postalCode: { type: GT.NonNull(GT.String) },
    country: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeCreateExternalAccountInput
