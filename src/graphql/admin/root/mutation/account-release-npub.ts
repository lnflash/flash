import { GT } from "@graphql/index"

import AccountDetailPayload from "@graphql/admin/types/payload/account-detail"
import { Accounts } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

const AccountReleaseNpubInput = GT.Input({
  name: "AccountReleaseNpubInput",
  fields: () => ({
    accountId: {
      type: GT.NonNullID,
    },
  }),
})

const AccountReleaseNpubMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: { accountId: string | Error }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountDetailPayload),
  args: {
    input: { type: GT.NonNull(AccountReleaseNpubInput) },
  },
  resolve: async (_, args) => {
    const { accountId } = args.input

    if (accountId instanceof Error) {
      return { errors: [{ message: accountId.message }] }
    }

    const account = await Accounts.releaseNpub(accountId)
    if (account instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(account)] }
    }

    return { errors: [], accountDetails: account }
  },
})

export default AccountReleaseNpubMutation
