import { GT } from "@graphql/index"
import { BankAccount } from "@services/frappe/models/BankAccount"
import ErpNext from "@services/frappe/ErpNext"
import { GraphQLObjectType } from "graphql"

import GraphQLBankAccountUpdateRequest from "./bank-account-update-request"

const GraphQLBankAccount: GraphQLObjectType<BankAccount> = GT.Object({
  name: "BankAccount",
  fields: () => ({
    id: {
      type: GT.ID,
      description: "ERPNext bank account identifier",
      resolve: (o) => o.name,
    },
    accountName: {
      type: GT.String,
      resolve: (o) => o.account_name,
    },
    bankName: {
      type: GT.NonNull(GT.String),
      resolve: (o) => o.bank,
    },
    bankBranch: {
      type: GT.NonNull(GT.String),
      resolve: (o) => o.branch_code,
    },
    accountNumber: {
      type: GT.NonNull(GT.String),
      resolve: (o) => o.bank_account_no,
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
    pendingUpdate: {
      type: GraphQLBankAccountUpdateRequest,
      description:
        "The account's in-flight update request when it needs the user's attention — Pending (awaiting review) or Rejected (declined). Null once approved/closed, or when none exists.",
      resolve: async (o) => {
        if (!o.name) return null
        const latest = await ErpNext.getLatestBankAccountUpdateRequestForAccount(o.name)
        if (latest instanceof Error) return null
        if (latest && (latest.status === "Pending" || latest.status === "Rejected")) {
          return latest
        }
        return null
      },
    },
  }),
})

export default GraphQLBankAccount
