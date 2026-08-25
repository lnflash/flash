import { GT } from "@graphql/index"

import AccountReleaseNpubPayload from "@graphql/admin/types/payload/account-release-npub"
import { Accounts } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

const AccountReleaseNpubInput = GT.Input({
  name: "AccountReleaseNpubInput",
  fields: () => ({
    accountId: {
      type: GT.NonNullID,
    },
    // Hands the freed key straight to the rightful owner. Omitted, the key goes
    // back to unclaimed and whoever polls for it first gets it.
    reassignToAccountId: {
      type: GT.ID,
    },
  }),
})

const AccountReleaseNpubMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: { accountId: string | Error; reassignToAccountId?: string | Error }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountReleaseNpubPayload),
  args: {
    input: { type: GT.NonNull(AccountReleaseNpubInput) },
  },
  resolve: async (_, args, ctx) => {
    const { accountId, reassignToAccountId } = args.input
    const supportUser = ctx.user.id

    if (accountId instanceof Error) return { errors: [{ message: accountId.message }] }
    if (reassignToAccountId instanceof Error) {
      return { errors: [{ message: reassignToAccountId.message }] }
    }

    const released = await Accounts.releaseNpub({
      id: accountId,
      releasedByUserId: supportUser,
      reassignToAccountId,
    })
    if (released instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(released)] }
    }

    return {
      errors: [],
      accountDetails: released.account,
      previousNpub: released.previousNpub,
      reassignedTo: released.reassignedTo,
    }
  },
})

export default AccountReleaseNpubMutation
