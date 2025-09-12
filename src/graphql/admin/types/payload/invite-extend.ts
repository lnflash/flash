import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"
import AdminInvite from "../object/admin-invite"

const InviteExtendPayload = GT.Object({
  name: "InviteExtendPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    invite: {
      type: AdminInvite,
    },
  }),
})

export default InviteExtendPayload