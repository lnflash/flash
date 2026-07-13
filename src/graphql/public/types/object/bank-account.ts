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
        "An open request to change this account's details, awaiting review. Null when none is pending.",
      resolve: async (o) => {
        if (!o.name) return null
        const requests = await ErpNext.getOpenBankAccountUpdateRequestsForAccount(o.name)
        if (requests instanceof Error) return null
        return requests[0] ?? null
      },
    },
  }),
})

export default GraphQLBankAccount
