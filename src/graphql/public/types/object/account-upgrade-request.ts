import { GT } from "@graphql/index"
import AccountLevel from "@graphql/shared/types/scalar/account-level"
import Address from "./address"
import BankAccount from "./bank-account"

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
    fullName: {
      type: GT.NonNull(GT.String),
    },
    phoneNumber: {
      type: GT.NonNull(GT.String),
    },
    email: {
      type: GT.String,
    },
    idDocument: {
      type: GT.NonNull(GT.Boolean),
      resolve: (source) => !!source.idDocument && source.idDocument !== "",
    },
    address: {
      type: GT.NonNull(Address),
    },
    terminalsRequested: {
      type: GT.NonNull(GT.Int),
    },
    bankAccount: {
      type: BankAccount,
    },
  }),
})

export default AccountUpgradeRequest
