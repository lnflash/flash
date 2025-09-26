import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapError } from "@graphql/error-map"
import AdminInvite from "@graphql/admin/types/object/admin-invite"

const InviteByIdQuery = GT.Field({
  type: AdminInvite,
  args: {
    id: { type: GT.NonNullID },
  },
  resolve: async (_, { id }) => {
    const invite = await Admin.getInviteById(id)
    
    if (invite instanceof Error) {
      throw mapError(invite)
    }

    return invite
  },
})

export default InviteByIdQuery