import { GT } from "@graphql/index"
import AccountLevel from "@graphql/shared/types/scalar/account-level"

const AccountUpgradeRequest = GT.Object({
  name: "AccountUpgradeRequest",
  fields: () => ({
    name: {
      type: GT.NonNull(GT.String),
      description: "ERPNext document name",
    },
    username: {
      type: GT.NonNull(GT.String),
    },
    currentLevel: {
      type: GT.NonNull(AccountLevel),
    },
    requestedLevel: {
      type: GT.NonNull(AccountLevel),
    },
    status: {
      type: GT.NonNull(GT.String),
      description: "Status of the upgrade request",
    },
    terminalRequested: {
      type: GT.NonNull(GT.Boolean),
      description: "Whether a PoS terminal is requested with the upgrade",
    },
    idDocument: {
      type: GT.NonNull(GT.Boolean),
      description: "Whether an ID document is provided with the upgrade request",
      resolve: (source) => Boolean(source.idDocument),
    },
    fullName: {
      type: GT.NonNull(GT.String),
    },
    phoneNumber: {
      type: GT.String,
    },
    email: {
      type: GT.String,
    },
    businessName: {
      type: GT.String,
    },
    businessAddress: {
      type: GT.String,
    },
  }),
})

export default AccountUpgradeRequest
