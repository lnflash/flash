import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapError } from "@graphql/error-map"
import { InputValidationError } from "@graphql/error"
import InvitesConnection from "@graphql/admin/types/object/invites-connection"
import InviteStatus from "@graphql/shared/types/scalar/invite-status"
import { checkedToAccountId } from "@domain/accounts"
import {
  connectionFromPaginatedArray,
  connectionArgs,
  checkedConnectionArgs,
} from "@graphql/connections"

const InvitesListQuery = GT.Field({
  type: GT.NonNull(InvitesConnection),
  args: {
    ...connectionArgs,
    status: { type: InviteStatus },
    inviterId: { type: GT.ID },
  },
  resolve: async (_, args) => {
    const checkedArgs = checkedConnectionArgs(args)
    if (checkedArgs instanceof Error) {
      throw mapError(checkedArgs)
    }

    // Convert inviterId to branded type if provided
    let processedInviterId: AccountId | undefined
    if (args.inviterId) {
      const checkedInviterId = checkedToAccountId(args.inviterId)
      if (checkedInviterId instanceof Error) {
        throw mapError(checkedInviterId)
      }
      processedInviterId = checkedInviterId
    }

    // Cursors are invite ObjectId hex strings (connectionFromPaginatedArray
    // uses item ids as cursors); page by _id, which is time-ordered.
    let afterId: string | undefined
    if (args.after) {
      if (!/^[a-f0-9]{24}$/i.test(args.after)) {
        throw mapError(new InputValidationError({ message: "Invalid cursor" }))
      }
      afterId = args.after
    }

    const invites = await Admin.listInvites({
      first: args.first || 20,
      afterId,
      status: args.status instanceof Error ? undefined : args.status,
      inviterId: processedInviterId,
    })

    if (invites instanceof Error) {
      throw mapError(invites)
    }

    const totalCount = invites.count?.[0]?.total || 0
    const items = invites.data || []

    return connectionFromPaginatedArray(items, totalCount, checkedArgs)
  },
})

export default InvitesListQuery
