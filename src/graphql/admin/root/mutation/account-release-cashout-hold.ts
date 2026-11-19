import { GT } from "@graphql/index"

import AccountDetailPayload from "@graphql/admin/types/payload/account-detail"
import { Accounts } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

const AccountReleaseCashoutHoldInput = GT.Input({
  name: "AccountReleaseCashoutHoldInput",
  fields: () => ({
    accountId: {
      type: GT.NonNullID,
    },
    comment: {
      type: GT.String,
      description: "Why the hold is released. Kept in the account's hold history.",
    },
  }),
})

// ENG-889: ops release a cash-out hold (placed when Bridge restricts or
// offboards the account's Bridge customer) once they have reviewed the
// account. Mirrors accountUpdateStatus, which is how ops unlock an account.
const AccountReleaseCashoutHoldMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: { accountId: string | Error; comment?: string | Error }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountDetailPayload),
  args: {
    input: { type: GT.NonNull(AccountReleaseCashoutHoldInput) },
  },
  resolve: async (_, args, ctx) => {
    const { accountId, comment } = args.input
    const supportUser = ctx.user.id

    if (accountId instanceof Error) return { errors: [{ message: accountId.message }] }
    if (comment instanceof Error) return { errors: [{ message: comment.message }] }

    const released = await Accounts.releaseCashoutHold({
      id: accountId,
      releasedByUserId: supportUser,
      comment,
    })
    if (released instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(released)] }
    }
    return { errors: [], accountDetails: released.account }
  },
})

export default AccountReleaseCashoutHoldMutation
