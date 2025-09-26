import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"
import AdminInvite from "../object/admin-invite"

const InviteRevokePayload = GT.Object({
  name: "InviteRevokePayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    invite: {
      type: AdminInvite,
    },
  }),
})

export default InviteRevokePayload