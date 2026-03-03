import { Accounts } from "@app"
import AccountDetailPayload from "@graphql/admin/types/payload/account-detail"
import AccountLevel from "@graphql/shared/types/scalar/account-level"
import { apolloErrorResponse, mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import { ValidationError } from "@domain/shared"
import { InputValidationError } from "@graphql/error"

const AccountUpdateLevelInput = GT.Input({
  name: "AccountUpdateLevelInput",
  fields: () => ({
    // FIXME: should be account id
    uid: {
      type: GT.NonNullID,
    },
    level: {
      type: GT.NonNull(AccountLevel),
    },
    erpParty: {
      type: GT.String,
    },
  }),
})

const AccountUpdateLevelMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      uid: string
      level: AccountLevel | Error
      erpParty?: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountDetailPayload),
  args: {
    input: { type: GT.NonNull(AccountUpdateLevelInput) },
  },
  resolve: async (_, args) => {
    // FIXME: should be account id
    const { uid, level, erpParty } = args.input

    for (const input of [uid, level]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    if (level instanceof Error) return { errors: [{ message: level.message }] }

    const account = await Accounts.updateAccountLevel({ id: uid, level, erpParty })

    if (account instanceof ValidationError) return apolloErrorResponse(new InputValidationError({ message: account.message })) 
    if (account instanceof Error) return { errors: [mapAndParseErrorForGqlResponse(account)] }
    return { errors: [], accountDetails: account }
  },
})

export default AccountUpdateLevelMutation
