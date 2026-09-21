import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BankAccountPayload from "@graphql/public/types/payload/bank-account"

const BankAccountSetDefaultInput = GT.Input({
  name: "BankAccountSetDefaultInput",
  fields: () => ({
    bankAccountId: {
      type: GT.NonNull(GT.ID),
      description: "ERPNext identifier of the account to make the default",
    },
  }),
})

const BankAccountSetDefaultMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  description: "Makes one of the customer's bank accounts the default cashout account.",
  type: GT.NonNull(BankAccountPayload),
  args: {
    input: { type: GT.NonNull(BankAccountSetDefaultInput) },
  },
  resolve: async (
    _,
    args: { input: { bankAccountId: string } },
    { domainAccount }: { domainAccount: Account },
  ) => {
    const result = await Accounts.setDefaultBankAccount(domainAccount.id, {
      bankAccountId: args.input.bankAccountId,
    })

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }
    return { errors: [], bankAccount: result }
  },
})

export default BankAccountSetDefaultMutation
