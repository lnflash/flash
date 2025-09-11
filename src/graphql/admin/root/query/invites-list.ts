import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapError } from "@graphql/error-map"
import InvitesConnection from "@graphql/admin/types/object/invites-connection"
import InviteStatus from "@graphql/shared/types/scalar/invite-status"

const InvitesListQuery = GT.Field({
  type: GT.NonNull(InvitesConnection),
  args: {
    first: { type: GT.Int },
    after: { type: GT.String },
    status: { type: InviteStatus },
    inviterId: { type: GT.ID },
  },
  resolve: async (_, args) => {
    const { first, after, status, inviterId } = args

    const invites = await Admin.listInvites({
      first: first || 20,
      after,
      status: status instanceof Error ? undefined : status,
      inviterId,
    })

    if (invites instanceof Error) {
      throw mapError(invites)
    }

    return invites
  },
})

export default InvitesListQuery