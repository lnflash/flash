import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapError } from "@graphql/error-map"
import InvitesConnection from "@graphql/admin/types/object/invites-connection"
import InviteStatus from "@graphql/shared/types/scalar/invite-status"
import { checkedToAccountId } from "@domain/accounts"

const InvitesListQuery = GT.Field({
  type: GT.NonNull(InvitesConnection),
  args: {
    first: { type: GT.Int },
    skip: { type: GT.Int },
    status: { type: InviteStatus },
    inviterId: { type: GT.ID },
  },
  resolve: async (_, args) => {
    const { first, skip, status, inviterId } = args

    // Convert inviterId to branded type if provided
    let processedInviterId: AccountId | undefined
    if (inviterId) {
      const checkedInviterId = checkedToAccountId(inviterId)
      if (checkedInviterId instanceof Error) {
        throw mapError(checkedInviterId)
      }
      processedInviterId = checkedInviterId
    }

    const invites = await Admin.listInvites({
      first: first || 20,
      skip: skip || 0,
      status: status instanceof Error ? undefined : status,
      inviterId: processedInviterId,
    })

    if (invites instanceof Error) {
      throw mapError(invites)
    }

    return invites
  },
})

export default InvitesListQuery
