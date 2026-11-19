import { GT } from "@graphql/index"

import AccountDetailPayload from "@graphql/admin/types/payload/account-detail"
import { Accounts } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

const AccountPlaceCashoutHoldInput = GT.Input({
  name: "AccountPlaceCashoutHoldInput",
  fields: () => ({
    accountId: {
      type: GT.NonNullID,
    },
    reason: {
      type: GT.NonNull(GT.String),
      description:
        "Why cash-outs are held. Kept on the hold and in the account's hold history; never shown to the account holder.",
    },
  }),
})

// ENG-889: ops hold cash-outs by hand, for example for a customer the Bridge
// customer status watch's first run listed as already restricted or
// offboarded. The hold is attributed to the calling admin. An account that is
// already held keeps its hold, and the payload shows that hold. Release with
// accountReleaseCashoutHold.
const AccountPlaceCashoutHoldMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: { accountId: string | Error; reason: string | Error }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountDetailPayload),
  args: {
    input: { type: GT.NonNull(AccountPlaceCashoutHoldInput) },
  },
  resolve: async (_, args, ctx) => {
    const { accountId, reason } = args.input
    const supportUser = ctx.user.id

    if (accountId instanceof Error) return { errors: [{ message: accountId.message }] }
    if (reason instanceof Error) return { errors: [{ message: reason.message }] }
    if (!reason.trim()) return { errors: [{ message: "A reason is required" }] }

    const placed = await Accounts.placeCashoutHoldByAdmin({
      id: accountId,
      reason: reason.trim(),
      placedByUserId: supportUser,
    })
    if (placed instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(placed)] }
    }
    // Placed or already held, the account's current hold is in the payload.
    return { errors: [], accountDetails: placed.account }
  },
})

export default AccountPlaceCashoutHoldMutation
