import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"

const AdminBroadcastSendPayload = GT.Object({
  name: "AdminBroadcastSendPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    success: {
      type: GT.Boolean,
    },
  }),
})

export default AdminBroadcastSendPayload
