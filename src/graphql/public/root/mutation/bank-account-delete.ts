import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import SuccessPayload, {
  SUCCESS_RESPONSE,
} from "@graphql/shared/types/payload/success-payload"

const BankAccountDeleteInput = GT.Input({
  name: "BankAccountDeleteInput",
  fields: () => ({
    bankAccountId: {
      type: GT.NonNull(GT.ID),
      description: "ERPNext identifier of the account to delete",
    },
  }),
})

const BankAccountDeleteMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  description:
    "Deletes a bank account. It can no longer be cashed out to. If it was the default, another account becomes the default.",
  type: GT.NonNull(SuccessPayload),
  args: {
    input: { type: GT.NonNull(BankAccountDeleteInput) },
  },
  resolve: async (
    _,
    args: { input: { bankAccountId: string } },
    { domainAccount }: { domainAccount: Account },
  ) => {
    const result = await Accounts.deleteBankAccount(domainAccount.id, {
      bankAccountId: args.input.bankAccountId,
    })

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)], success: false }
    }
    return SUCCESS_RESPONSE
  },
})

export default BankAccountDeleteMutation
