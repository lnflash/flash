import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountNumber from "@graphql/shared/types/scalar/account-number"
import BankAccountPayload from "@graphql/public/types/payload/bank-account"

const BankAccountAddInput = GT.Input({
  name: "BankAccountAddInput",
  fields: () => ({
    bankName: {
      type: GT.NonNull(GT.String),
      description: "Must be one of supportedBanks",
    },
    bankBranch: { type: GT.NonNull(GT.String) },
    accountType: {
      type: GT.NonNull(GT.String),
      description: "Chequing or Savings",
    },
    currency: {
      type: GT.NonNull(GT.String),
      description: "JMD or USD. Cannot be changed afterwards.",
    },
    accountNumber: { type: GT.NonNull(AccountNumber) },
    accountName: {
      type: GT.String,
      description: "Name of the account holder",
    },
    setDefault: {
      type: GT.Boolean,
      description:
        "Make this the default account. The customer's first account is always the default.",
    },
  }),
})

type BankAccountAddInputType = {
  bankName: string
  bankBranch: string
  accountType: string
  currency: string
  accountNumber: string
  accountName?: string | null
  setDefault?: boolean | null
}

const BankAccountAddMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  description: "Adds a bank account for cashouts. Takes effect immediately (no review).",
  type: GT.NonNull(BankAccountPayload),
  args: {
    input: { type: GT.NonNull(BankAccountAddInput) },
  },
  resolve: async (
    _,
    args: { input: BankAccountAddInputType },
    { domainAccount }: { domainAccount: Account },
  ) => {
    const result = await Accounts.addBankAccount(domainAccount.id, args.input)

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }
    return { errors: [], bankAccount: result }
  },
})

export default BankAccountAddMutation
