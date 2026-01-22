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
      description: "Workflow status of the upgrade request",
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
