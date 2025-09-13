import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapError } from "@graphql/error-map"
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

    // Calculate skip from cursor
    let skip = 0
    if (args.after) {
      // For cursor-based pagination, we could store the last seen ID
      // For now, we'll use a simple numeric approach
      try {
        skip = parseInt(args.after, 16) || 0
      } catch {
        skip = 0
      }
    }

    const invites = await Admin.listInvites({
      first: args.first || 20,
      skip,
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
