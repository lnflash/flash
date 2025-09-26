import { GT } from "@graphql/index"
import Username from "@graphql/shared/types/scalar/username"
import Timestamp from "@graphql/shared/types/scalar/timestamp"
import InviteMethod from "@graphql/shared/types/scalar/invite-method"
import InviteStatus from "@graphql/shared/types/scalar/invite-status"

const AdminInvite = GT.Object({
  name: "AdminInvite",
  fields: () => ({
    id: {
      type: GT.NonNullID,
    },
    contact: {
      type: GT.NonNull(GT.String),
    },
    method: {
      type: GT.NonNull(InviteMethod),
    },
    status: {
      type: GT.NonNull(InviteStatus),
    },
    inviterAccountId: {
      type: GT.NonNullID,
    },
    inviterUsername: {
      type: Username,
    },
    redeemerAccountId: {
      type: GT.ID,
    },
    redeemerUsername: {
      type: Username,
    },
    createdAt: {
      type: GT.NonNull(Timestamp),
    },
    expiresAt: {
      type: GT.NonNull(Timestamp),
    },
    redeemedAt: {
      type: Timestamp,
    },
  }),
})

export default AdminInvite