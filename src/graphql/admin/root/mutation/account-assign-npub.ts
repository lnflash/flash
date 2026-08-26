import { GT } from "@graphql/index"

import AccountAssignNpubPayload from "@graphql/admin/types/payload/account-assign-npub"
import { Accounts } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import Npub from "@graphql/shared/types/scalar/npub"

const AccountAssignNpubInput = GT.Input({
  name: "AccountAssignNpubInput",
  fields: () => ({
    accountId: {
      type: GT.NonNullID,
    },
    // The `npub` scalar, not String: it validates and normalises at the
    // boundary, the same way `accountDetailsByNpub` does. A mutation that
    // mints a permanent identity claim should not accept a looser input than
    // the query that merely reads one.
    npub: {
      type: GT.NonNull(Npub),
    },
  }),
})

const AccountAssignNpubMutation = GT.Field<
  null,
  GraphQLAdminContext,
  { input: { accountId: string | Error; npub: Npub | ValidationError } }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountAssignNpubPayload),
  args: {
    input: { type: GT.NonNull(AccountAssignNpubInput) },
  },
  resolve: async (_, args, ctx) => {
    const { accountId, npub } = args.input
    const supportUser = ctx.user.id

    if (accountId instanceof Error) return { errors: [{ message: accountId.message }] }
    if (npub instanceof Error) return { errors: [{ message: npub.message }] }

    const assigned = await Accounts.assignNpub({
      id: accountId,
      npub,
      assignedByUserId: supportUser,
    })
    if (assigned instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(assigned)] }
    }

    return { errors: [], accountDetails: assigned }
  },
})

export default AccountAssignNpubMutation
