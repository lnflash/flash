import { GT } from "@graphql/index"
import { GraphQLObjectType } from "graphql"
import { BankAccountUpdateRequest } from "@services/frappe/models/BankAccountUpdateRequest"

const GraphQLBankAccountUpdateRequest: GraphQLObjectType<BankAccountUpdateRequest> =
  GT.Object({
    name: "BankAccountUpdateRequest",
    description:
      "A pending request to change the details of an approved bank account, awaiting admin review.",
    fields: () => ({
      status: {
        type: GT.NonNull(GT.String),
        description: "Pending | Approved | Rejected | Closed",
        resolve: (o) => o.status,
      },
      bankName: {
        type: GT.NonNull(GT.String),
        description: "Proposed new bank name",
        resolve: (o) => o.newBankAccount.bank,
      },
      bankBranch: {
        type: GT.NonNull(GT.String),
        description: "Proposed new bank branch",
        resolve: (o) => o.newBankAccount.branch_code,
      },
      accountType: {
        type: GT.NonNull(GT.String),
        description: "Proposed new account type",
        resolve: (o) => o.newBankAccount.account_type,
      },
      accountNumber: {
        type: GT.NonNull(GT.String),
        description: "Proposed new account number",
        resolve: (o) => o.newBankAccount.bank_account_no,
      },
      currency: {
        type: GT.NonNull(GT.String),
        description: "Account currency (unchanged from the current account)",
        resolve: (o) => o.newBankAccount.currency,
      },
      rejectionReason: {
        type: GT.String,
        description: "Reviewer note, set when status is Rejected",
        resolve: (o) => o.supportNote || null,
      },
    }),
  })

export default GraphQLBankAccountUpdateRequest
