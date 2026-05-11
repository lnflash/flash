import { GT } from "@graphql/index"
import { BankAccount } from "@services/frappe/models/BankAccount"
import { GraphQLObjectType } from "graphql"

const GraphQLBankAccount: GraphQLObjectType<BankAccount> = GT.Object({
  name: "BankAccount",
  fields: () => ({
    id: {
      type: GT.NonNullID,
      description: "ERPNext bank account identifier",
      resolve: (o) => o.name,
    },
    accountName: {
      type: GT.NonNull(GT.String),
      resolve: (o) => o.account_name,
    },
    bank: {
      type: GT.NonNull(GT.String),
      description: "Name of the bank institution",
      resolve: (o) => o.bank,
    },
    accountNumber: {
      type: GT.NonNull(GT.String),
      resolve: (o) => o.bank_account_no,
    },
    branchCode: {
      type: GT.NonNull(GT.String),
      resolve: (o) => o.branch_code,
    },
    accountType: {
      type: GT.NonNull(GT.String),
      resolve: (o) => o.account_type,
    },
    currency: {
      type: GT.NonNull(GT.String),
      description: "Account currency (e.g. JMD, USD)",
      resolve: (o) => o.currency,
    },
    isDefault: {
      type: GT.NonNull(GT.Boolean),
      resolve: (o) => o.is_default === 1,
    },
  }),
})

export default GraphQLBankAccount
