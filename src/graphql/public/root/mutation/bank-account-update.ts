import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountNumber from "@graphql/shared/types/scalar/account-number"
import BankAccountPayload from "@graphql/public/types/payload/bank-account"

const BankAccountUpdateInput = GT.Input({
  name: "BankAccountUpdateInput",
  description:
    "New details for an existing bank account. Currency is locked: to change it, add a new account.",
  fields: () => ({
    bankAccountId: {
      type: GT.NonNull(GT.ID),
      description: "ERPNext identifier of the account to update",
    },
    bankName: {
      type: GT.NonNull(GT.String),
      description: "Must be one of supportedBanks",
    },
    bankBranch: { type: GT.NonNull(GT.String) },
    accountType: {
      type: GT.NonNull(GT.String),
      description: "Chequing or Savings",
    },
    accountNumber: { type: GT.NonNull(AccountNumber) },
    accountName: {
      type: GT.String,
      description: "Name of the account holder. Unchanged when omitted.",
    },
  }),
})

type BankAccountUpdateInputType = {
  bankAccountId: string
  bankName: string
  bankBranch: string
  accountType: string
  accountNumber: string
  accountName?: string | null
}

const BankAccountUpdateMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  description:
    "Updates a bank account's details. Takes effect immediately (no review) and closes any pending update request for the account.",
  type: GT.NonNull(BankAccountPayload),
  args: {
    input: { type: GT.NonNull(BankAccountUpdateInput) },
  },
  resolve: async (
    _,
    args: { input: BankAccountUpdateInputType },
    { domainAccount }: { domainAccount: Account },
  ) => {
    const result = await Accounts.updateBankAccount(domainAccount.id, args.input)

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }
    return { errors: [], bankAccount: result }
  },
})

export default BankAccountUpdateMutation
